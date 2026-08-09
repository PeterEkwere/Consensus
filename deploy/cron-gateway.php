<?php
declare(strict_types=1);

/*
 * Short-lived scheduler bridge for shared hosting.
 *
 * Deploy this file inside a randomly named directory directly below the
 * staging.forefada.com Laravel public directory. It contains no credential.
 * Request secrets and every bot file remain in the private Consensus directory.
 */

umask(0077);
ignore_user_abort(true);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

function finish(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES), "\n";
    exit;
}

function previousRunFailed(string $repo, string $task): bool
{
    $statusFile = $repo . '/.scheduler-' . $task . '.status';
    if (!is_file($statusFile)) return false;
    $parts = preg_split('/\s+/', trim((string) file_get_contents($statusFile))) ?: [];
    $previousState = (string) ($parts[0] ?? '');
    $previousTime = (int) ($parts[1] ?? 0);
    return $previousState === 'failed'
        || ($previousState === 'running' && $previousTime > 0 && time() - $previousTime > 180);
}

function launchTask(
    string $repo,
    string $accountUser,
    string $knownHosts,
    string $task,
): bool {
    $sshKey = $repo . '/.scheduler-ssh-' . $task;
    if (!is_file($sshKey)) return false;
    $sshCommand = [
        '/usr/bin/ssh',
        '-i', $sshKey,
        '-p', '65002',
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' . $knownHosts,
        '-o', 'ConnectTimeout=10',
        '-o', 'ConnectionAttempts=1',
        $accountUser . '@127.0.0.1',
        'scheduled',
    ];
    $launchCommand = 'nohup '
        . implode(' ', array_map('escapeshellarg', $sshCommand))
        . ' >/dev/null 2>&1 </dev/null &';
    $descriptors = [
        0 => ['file', '/dev/null', 'r'],
        1 => ['file', '/dev/null', 'a'],
        2 => ['file', '/dev/null', 'a'],
    ];
    $environment = [
        'PATH' => '/usr/bin:/bin',
        'NODE_ENV' => 'production',
        'LANG' => 'C.UTF-8',
    ];
    $pipes = [];
    $process = @proc_open(
        ['/bin/sh', '-c', $launchCommand],
        $descriptors,
        $pipes,
        $repo,
        $environment,
        ['bypass_shell' => true],
    );
    return is_resource($process) && proc_close($process) === 0;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    finish(404, ['ok' => false]);
}

// __DIR__ is <home>/domains/forefada.com/public_html/staging/public/<random>.
$accountRoot = dirname(__DIR__, 6);
$repo = $accountRoot . '/.consensus-reaper';
$accountUser = basename($accountRoot);
$secretFile = $repo . '/.cron-trigger-secret';
$githubSecretFile = $repo . '/.github-webhook-secret';
$runner = $repo . '/deploy/scheduled-runner.sh';
$knownHosts = $repo . '/.scheduler-ssh-known-hosts';

$secret = is_file($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
$provided = trim((string) ($_SERVER['HTTP_X_CONSENSUS_SCHEDULER'] ?? ''));
$directAuthorized = strlen($secret) >= 32
    && strlen($provided) >= 32
    && hash_equals($secret, $provided);

$rawBody = (string) file_get_contents('php://input');
$githubSecret = is_file($githubSecretFile) ? trim((string) file_get_contents($githubSecretFile)) : '';
$githubSignature = trim((string) ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? ''));
$expectedSignature = strlen($githubSecret) >= 32
    ? 'sha256=' . hash_hmac('sha256', $rawBody, $githubSecret)
    : '';
$githubSigned = strlen($expectedSignature) === 71
    && strlen($githubSignature) === 71
    && hash_equals($expectedSignature, $githubSignature);
$githubEvent = (string) ($_SERVER['HTTP_X_GITHUB_EVENT'] ?? '');

if ($githubSigned && $githubEvent === 'ping') {
    finish(200, ['ok' => true, 'status' => 'ready']);
}

$tasks = [];
if ($directAuthorized) {
    $task = (string) ($_GET['task'] ?? '');
    if (in_array($task, ['consensus', 'edge'], true)) $tasks = [$task];
} elseif ($githubSigned && $githubEvent === 'repository_dispatch') {
    $payload = json_decode($rawBody, true);
    if (is_array($payload) && ($payload['action'] ?? '') === 'consensus_scheduler_tick') {
        $tasks = ['consensus', 'edge'];
    }
}
if (!$tasks) {
    finish(404, ['ok' => false]);
}
if (!is_dir($repo) || !is_file($runner) || !is_file($knownHosts)) {
    finish(503, ['ok' => false, 'status' => 'runtime-unavailable']);
}

$previousFailed = false;
foreach ($tasks as $task) {
    $previousFailed = $previousFailed || previousRunFailed($repo, $task);
    if (!launchTask($repo, $accountUser, $knownHosts, $task)) {
        finish(503, ['ok' => false, 'status' => 'start-failed']);
    }
}
if ($directAuthorized && $previousFailed) {
    finish(500, ['ok' => false, 'status' => 'previous-run-failed']);
}
finish(202, ['ok' => true, 'status' => 'accepted']);
