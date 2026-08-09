<?php
declare(strict_types=1);

/*
 * Short-lived scheduler bridge for shared hosting.
 *
 * Deploy this file inside a randomly named directory directly below the
 * staging.forefada.com Laravel public directory. It contains no credential. The request
 * secret and every bot file remain in the private Consensus directory.
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

function privateLog(string $file, array $row): void
{
    if (is_file($file) && filesize($file) > 524288) {
        @rename($file, $file . '.1');
    }
    $line = json_encode($row, JSON_UNESCAPED_SLASHES) . "\n";
    @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
    @chmod($file, 0600);
}

function cleanDiagnostic(string $value): string
{
    $value = preg_replace('/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/', '[redacted-token]', $value) ?? '';
    $value = preg_replace('/Authorization:\s*[^\s]+/i', 'Authorization: [redacted]', $value) ?? '';
    $value = preg_replace('/[\r\n\t]+/', ' ', $value) ?? '';
    return substr(trim($value), -2000);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    finish(404, ['ok' => false]);
}

// __DIR__ is <home>/domains/forefada.com/public_html/staging/public/<random>.
$home = dirname(__DIR__, 6);
$repo = $home . '/.consensus-reaper';
$secretFile = $repo . '/.cron-trigger-secret';
$logFile = $repo . '/.scheduler.log';
$node = $home . '/.nvm/versions/node/v22.22.0/bin/node';

$secret = is_file($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
$provided = trim((string) ($_SERVER['HTTP_X_CONSENSUS_SCHEDULER'] ?? ''));
if (strlen($secret) < 32 || strlen($provided) < 32 || !hash_equals($secret, $provided)) {
    finish(404, ['ok' => false]);
}

$task = (string) ($_GET['task'] ?? '');
$tasks = [
    'consensus' => [
        'script' => $repo . '/bot.js',
        'command' => [$node, '--max-old-space-size=96', $repo . '/bot.js', '--scheduled-run'],
        'timeout' => 52,
    ],
    'edge' => [
        'script' => $repo . '/edge-bot/edge-bot.js',
        'command' => [$node, '--max-old-space-size=96', $repo . '/edge-bot/edge-bot.js', 'scheduled-run'],
        'timeout' => 48,
    ],
];
if (!isset($tasks[$task])) {
    finish(404, ['ok' => false]);
}
if (!is_dir($repo) || !is_file($node) || !is_file($tasks[$task]['script'])) {
    privateLog($logFile, ['at' => gmdate('c'), 'task' => $task, 'status' => 'missing-runtime']);
    finish(503, ['ok' => false, 'status' => 'runtime-unavailable']);
}

$lockPath = $repo . '/.scheduler-' . $task . '.lock';
$lock = @fopen($lockPath, 'c+');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    if (is_resource($lock)) fclose($lock);
    finish(202, ['ok' => true, 'status' => 'already-running']);
}
@chmod($lockPath, 0600);

$descriptors = [
    0 => ['pipe', 'r'],
    1 => ['pipe', 'w'],
    2 => ['pipe', 'w'],
];
$environment = [
    'HOME' => $home,
    'PATH' => dirname($node) . ':/usr/bin:/bin',
    'NODE_ENV' => 'production',
    'LANG' => 'C.UTF-8',
];
$options = ['bypass_shell' => true];
$pipes = [];
$started = microtime(true);
$process = @proc_open($tasks[$task]['command'], $descriptors, $pipes, $repo, $environment, $options);
if (!is_resource($process)) {
    flock($lock, LOCK_UN);
    fclose($lock);
    privateLog($logFile, ['at' => gmdate('c'), 'task' => $task, 'status' => 'start-failed']);
    finish(503, ['ok' => false, 'status' => 'start-failed']);
}

fclose($pipes[0]);
stream_set_blocking($pipes[1], false);
stream_set_blocking($pipes[2], false);
$stdout = '';
$stderr = '';
$exitCode = -1;
$timedOut = false;
$timeout = (int) $tasks[$task]['timeout'];

while (true) {
    $status = proc_get_status($process);
    foreach ([1, 2] as $index) {
        $chunk = stream_get_contents($pipes[$index]);
        if ($chunk === false || $chunk === '') continue;
        if ($index === 1) $stdout = substr($stdout . $chunk, -8192);
        else $stderr = substr($stderr . $chunk, -8192);
    }

    if (!$status['running']) {
        $exitCode = (int) $status['exitcode'];
        break;
    }
    if (microtime(true) - $started > $timeout) {
        $timedOut = true;
        @proc_terminate($process);
        usleep(250000);
        $afterTerm = proc_get_status($process);
        if ($afterTerm['running']) @proc_terminate($process, 9);
        break;
    }
    usleep(50000);
}

foreach ([1, 2] as $index) {
    $chunk = stream_get_contents($pipes[$index]);
    if ($chunk !== false && $chunk !== '') {
        if ($index === 1) $stdout = substr($stdout . $chunk, -8192);
        else $stderr = substr($stderr . $chunk, -8192);
    }
    fclose($pipes[$index]);
}
$closedCode = proc_close($process);
if ($exitCode < 0 && $closedCode >= 0) $exitCode = $closedCode;
$durationMs = (int) round((microtime(true) - $started) * 1000);

flock($lock, LOCK_UN);
fclose($lock);

privateLog($logFile, [
    'at' => gmdate('c'),
    'task' => $task,
    'status' => $timedOut ? 'timeout' : ($exitCode === 0 ? 'ok' : 'failed'),
    'exitCode' => $exitCode,
    'durationMs' => $durationMs,
    'stdout' => cleanDiagnostic($stdout),
    'stderr' => cleanDiagnostic($stderr),
]);

if ($timedOut) finish(504, ['ok' => false, 'status' => 'timeout', 'durationMs' => $durationMs]);
if ($exitCode !== 0) finish(500, ['ok' => false, 'status' => 'failed', 'durationMs' => $durationMs]);
finish(200, ['ok' => true, 'status' => 'complete', 'durationMs' => $durationMs]);
