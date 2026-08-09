<?php
declare(strict_types=1);

/*
 * Short-lived scheduler bridge for shared hosting.
 *
 * Deploy this file inside a randomly named directory directly below the
 * staging.forefada.com Laravel public directory. It contains no credential.
 * The request secret and every bot file remain in the private Consensus directory.
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

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    finish(404, ['ok' => false]);
}

// __DIR__ is <home>/domains/forefada.com/public_html/staging/public/<random>.
$accountRoot = dirname(__DIR__, 6);
$repo = $accountRoot . '/.consensus-reaper';
$accountUser = basename($accountRoot);
$secretFile = $repo . '/.cron-trigger-secret';
$runner = $repo . '/deploy/scheduled-runner.sh';

$secret = is_file($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
$provided = trim((string) ($_SERVER['HTTP_X_CONSENSUS_SCHEDULER'] ?? ''));
if (strlen($secret) < 32 || strlen($provided) < 32 || !hash_equals($secret, $provided)) {
    finish(404, ['ok' => false]);
}

$task = (string) ($_GET['task'] ?? '');
if (!in_array($task, ['consensus', 'edge'], true)) {
    finish(404, ['ok' => false]);
}
$sshKey = $repo . '/.scheduler-ssh-' . $task;
$knownHosts = $repo . '/.scheduler-ssh-known-hosts';
if (!is_dir($repo) || !is_file($runner) || !is_file($sshKey) || !is_file($knownHosts)) {
    finish(503, ['ok' => false, 'status' => 'runtime-unavailable']);
}

$previousFailed = false;
$statusFile = $repo . '/.scheduler-' . $task . '.status';
if (is_file($statusFile)) {
    $parts = preg_split('/\s+/', trim((string) file_get_contents($statusFile))) ?: [];
    $previousState = (string) ($parts[0] ?? '');
    $previousTime = (int) ($parts[1] ?? 0);
    $previousFailed = $previousState === 'failed'
        || ($previousState === 'running' && $previousTime > 0 && time() - $previousTime > 180);
}

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
$options = ['bypass_shell' => true];
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
$pipes = [];
$process = @proc_open(['/bin/sh', '-c', $launchCommand], $descriptors, $pipes, $repo, $environment, $options);
if (!is_resource($process)) {
    finish(503, ['ok' => false, 'status' => 'start-failed']);
}
$launchCode = proc_close($process);
if ($launchCode !== 0) {
    finish(503, ['ok' => false, 'status' => 'start-failed']);
}
if ($previousFailed) {
    finish(500, ['ok' => false, 'status' => 'previous-run-failed']);
}
finish(202, ['ok' => true, 'status' => 'accepted']);
