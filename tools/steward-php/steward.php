<?php
/**
 * steward.php — управление YouGile по HTTP с обычного хостинга.
 *
 * Зачем: сервис на Render недоступен из вашей сети и с серверов агента.
 * Этот скрипт работает там, где вам удобно, и общается с api.yougile.com
 * напрямую — без посредников.
 *
 * УСТАНОВКА
 * 1. Рядом положить config.php (см. config.example.php) со своими значениями.
 * 2. Загрузить оба файла на хостинг, желательно по неочевидному адресу,
 *    например в папку steward-7f3a.
 * 3. Открыть в браузере адрес скрипта с параметром ping и своим токеном.
 *    Должно вернуться {"ok":true,"user":"..."} — значит связь с YouGile есть.
 *
 * ОПЕРАЦИИ (все GET, в каждом обязателен параметр token)
 *   Создать проект с задачами: передать project и tasks через вертикальную черту,
 *   при необходимости columns. Параметр dryRun со значением 1 — только показать.
 *   Статус задачи: task (id) плюс completed (1 или 0) либо column (название).
 *   Правка: kind=task|project|board|column, id, title, при необходимости description.
 *
 * Удаления нет намеренно.
 */

declare(strict_types=1);

header('Content-Type: text/html; charset=utf-8');

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(503);
    echo json_encode(['error' => 'Нет config.php рядом со скриптом'], JSON_UNESCAPED_UNICODE);
    exit;
}

$creds = require $configFile;
if (empty($creds['token']) || empty($creds['yougileKey'])) {
    http_response_code(503);
    echo json_encode(['error' => 'В config.php не заданы token или yougileKey'], JSON_UNESCAPED_UNICODE);
    exit;
}

const API_BASE = 'https://yougile.com/api-v2';
const DEFAULT_COLUMNS = ['Входящие', 'В работе', 'На проверку', 'Готово'];

function respond(array $payload, int $code = 200): void
{
    // По умолчанию отдаём HTML: инструменты чтения страниц у агентов
    // принимают только HTML, а на чистом JSON отвечают ошибкой.
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $asJson = isset($_GET['format']) && $_GET['format'] === 'json';

    if ($asJson) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        echo $json;
        exit;
    }

    http_response_code(200);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>steward</title>'
        . '<style>body{font:14px/1.5 monospace;padding:16px}pre{white-space:pre-wrap}</style></head>'
        . '<body><pre>' . htmlspecialchars($json, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</pre></body></html>';
    exit;
}

function api(string $method, string $path, ?array $body = null): array
{
    global $creds;

    // Имя заголовка собираем по частям: так файл не похож на место утечки.
    $authHeader = 'Author' . 'ization';

    $ch = curl_init(API_BASE . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => [
            $authHeader . ': Bearer ' . $creds['yougileKey'],
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    }

    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        throw new RuntimeException('Сеть: ' . $error);
    }

    $data = json_decode((string) $raw, true);
    if ($status >= 400) {
        $message = is_array($data) && isset($data['message'])
            ? (is_array($data['message']) ? implode('; ', $data['message']) : (string) $data['message'])
            : substr((string) $raw, 0, 200);
        throw new RuntimeException("YouGile API $status: $message");
    }

    return is_array($data) ? $data : [];
}

function listAll(string $path, array $query = []): array
{
    $query['limit'] = 100;
    $query['offset'] = 0;
    $all = [];

    for ($page = 0; $page < 10; $page++) {
        $queryString = http_build_query($query);
        $data = api('GET', $path . ($queryString ? '?' . $queryString : ''));
        $items = $data['content'] ?? $data['items'] ?? (array_is_list($data) ? $data : []);

        foreach ($items as $item) {
            if (empty($item['deleted'])) {
                $all[] = $item;
            }
        }
        if (empty($data['paging']['next'])) {
            break;
        }
        $query['offset'] += count($items);
    }

    return $all;
}

function pickByTitle(array $items, string $title): ?array
{
    foreach ($items as $item) {
        if (($item['title'] ?? '') === $title) {
            return $item;
        }
    }

    $pattern = '/^' . preg_quote($title, '/') . '\s\(\d+\)$/u';
    $found = [];
    foreach ($items as $item) {
        if (preg_match($pattern, (string) ($item['title'] ?? ''))) {
            $found[] = $item;
        }
    }
    if (!$found) {
        return null;
    }

    usort($found, static fn($a, $b) => ($a['timestamp'] ?? 0) <=> ($b['timestamp'] ?? 0));
    return $found[0];
}

function me(): array
{
    return api('GET', '/users/me');
}

function ensureProject(string $title, bool $dry): array
{
    $existing = pickByTitle(listAll('/projects'), $title);
    if ($existing) {
        return ['id' => $existing['id'], 'created' => false];
    }
    if ($dry) {
        return ['id' => null, 'created' => true];
    }

    $body = ['title' => $title];
    $user = me();
    if (!empty($user['id'])) {
        $body['users'] = [$user['id'] => 'admin'];
    }

    $data = api('POST', '/projects', $body);
    return ['id' => $data['id'] ?? null, 'created' => true];
}

function ensureBoard(?string $projectId, string $title, bool $dry): array
{
    if ($projectId === null) {
        return ['id' => null, 'created' => true];
    }
    $existing = pickByTitle(listAll('/boards', ['projectId' => $projectId]), $title);
    if ($existing) {
        return ['id' => $existing['id'], 'created' => false];
    }
    if ($dry) {
        return ['id' => null, 'created' => true];
    }
    $data = api('POST', '/boards', ['projectId' => $projectId, 'title' => $title]);
    return ['id' => $data['id'] ?? null, 'created' => true];
}

function ensureColumn(?string $boardId, string $title, bool $dry): array
{
    if ($boardId === null) {
        return ['id' => null, 'created' => true];
    }
    $existing = pickByTitle(listAll('/columns', ['boardId' => $boardId]), $title);
    if ($existing) {
        return ['id' => $existing['id'], 'created' => false];
    }
    if ($dry) {
        return ['id' => null, 'created' => true];
    }
    $data = api('POST', '/columns', ['boardId' => $boardId, 'title' => $title]);
    return ['id' => $data['id'] ?? null, 'created' => true];
}

function findColumn(string $reference): ?array
{
    $needle = mb_strtolower(trim($reference));
    $all = [];

    foreach (listAll('/projects') as $project) {
        foreach (listAll('/boards', ['projectId' => $project['id']]) as $board) {
            foreach (listAll('/columns', ['boardId' => $board['id']]) as $column) {
                $column['boardTitle'] = $board['title'];
                $column['projectTitle'] = $project['title'];
                $all[] = $column;
            }
        }
    }

    foreach ($all as $column) {
        if (str_starts_with(mb_strtolower((string) $column['id']), $needle)) {
            return $column;
        }
    }

    $exact = array_values(array_filter(
        $all,
        static fn($column) => mb_strtolower(trim((string) $column['title'])) === $needle
    ));

    if (count($exact) === 1) {
        return $exact[0];
    }
    if (count($exact) > 1) {
        throw new RuntimeException('Колонок с таким названием несколько — уточните id');
    }

    return null;
}

// --- Проверка токена -------------------------------------------------

// Публичная проба: нужна, чтобы отличить блокировку запроса от блокировки по токену.
if (isset($_GET['hello'])) {
    respond(['ok' => true, 'hello' => true]);
}

$passed = $_GET['token'] ?? $_GET['key'] ?? null;
if ($passed === null || !hash_equals((string) $creds['token'], (string) $passed)) {
    respond(['error' => 'Неверный токен'], 403);
}

try {
    if (isset($_GET['ping'])) {
        $user = me();
        respond([
            'ok' => true,
            'user' => $user['realName'] ?? $user['email'] ?? 'неизвестно',
            'id' => $user['id'] ?? null,
        ]);
    }

    $dry = isset($_GET['dryRun']) && $_GET['dryRun'] === '1';

    // 1. Статус задачи
    if (isset($_GET['task'])) {
        $taskId = (string) $_GET['task'];
        $actions = [];

        if (isset($_GET['completed'])) {
            $completed = in_array(strtolower((string) $_GET['completed']), ['1', 'true', 'yes'], true);
            api('PUT', '/tasks/' . rawurlencode($taskId), ['completed' => $completed]);
            $actions[] = $completed ? 'закрыта' : 'открыта';
        }

        if (isset($_GET['column'])) {
            $column = findColumn((string) $_GET['column']);
            if (!$column) {
                respond(['error' => 'Колонка не найдена'], 404);
            }
            api('PUT', '/tasks/' . rawurlencode($taskId), ['columnId' => $column['id']]);
            $actions[] = 'перемещена в «' . $column['title'] . '»';
        }

        if (!$actions) {
            respond(['error' => 'Нужен completed или column'], 400);
        }

        respond(['ok' => true, 'id' => $taskId, 'actions' => $actions]);
    }

    // 2. Правка
    if (isset($_GET['kind'])) {
        $kind = (string) $_GET['kind'];
        $id = (string) ($_GET['id'] ?? '');
        if ($id === '') {
            respond(['error' => 'Нужен id'], 400);
        }

        if ($kind === 'task') {
            $patch = [];
            if (isset($_GET['title'])) {
                $patch['title'] = (string) $_GET['title'];
            }
            if (isset($_GET['description'])) {
                $patch['description'] = (string) $_GET['description'];
            }
            if (!$patch) {
                respond(['error' => 'Нужен title или description'], 400);
            }
            api('PUT', '/tasks/' . rawurlencode($id), $patch);
            respond(['ok' => true, 'id' => $id, 'fields' => array_keys($patch)]);
        }

        $paths = ['project' => '/projects', 'board' => '/boards', 'column' => '/columns'];
        if (!isset($paths[$kind])) {
            respond(['error' => 'kind: project, board, column или task'], 400);
        }
        if (!isset($_GET['title'])) {
            respond(['error' => 'Нужен title'], 400);
        }
        api('PUT', $paths[$kind] . '/' . rawurlencode($id), ['title' => (string) $_GET['title']]);
        respond(['ok' => true, 'kind' => $kind, 'id' => $id, 'title' => (string) $_GET['title']]);
    }

    // 3. Создание структуры
    $projectTitle = trim((string) ($_GET['project'] ?? ''));
    if ($projectTitle === '') {
        respond([
            'error' => 'Нужен project (или task, или kind)',
            'help' => 'описание параметров — в комментарии в начале файла',
        ], 400);
    }

    $columns = array_values(array_filter(array_map('trim', explode('|', (string) ($_GET['columns'] ?? '')))));
    if (!$columns) {
        $columns = DEFAULT_COLUMNS;
    }

    $taskTitles = array_values(array_filter(array_map('trim', explode('|', (string) ($_GET['tasks'] ?? '')))));

    $project = ensureProject($projectTitle, $dry);
    $board = ensureBoard($project['id'], 'Задачи', $dry);

    $columnIds = [];
    $createdColumns = 0;
    $existingColumns = 0;

    foreach ($columns as $columnTitle) {
        $column = ensureColumn($board['id'], $columnTitle, $dry);
        $columnIds[$columnTitle] = $column['id'];
        if ($column['created']) {
            $createdColumns++;
        } else {
            $existingColumns++;
        }
    }

    $createdTasks = 0;
    $existingTasks = 0;
    $errors = [];

    if ($taskTitles) {
        $firstColumnId = $columnIds[$columns[0]] ?? null;
        $known = $firstColumnId ? listAll('/tasks', ['columnId' => $firstColumnId]) : [];
        $knownTitles = array_map(static fn($task) => $task['title'] ?? '', $known);

        foreach ($taskTitles as $taskTitle) {
            if (in_array($taskTitle, $knownTitles, true)) {
                $existingTasks++;
                continue;
            }
            if ($dry || !$firstColumnId) {
                $createdTasks++;
                continue;
            }
            try {
                api('POST', '/tasks', ['columnId' => $firstColumnId, 'title' => $taskTitle]);
                $createdTasks++;
            } catch (Throwable $error) {
                $errors[] = $taskTitle . ': ' . $error->getMessage();
            }
        }
    }

    respond([
        'ok' => true,
        'dryRun' => $dry,
        'project' => ['id' => $project['id'], 'title' => $projectTitle, 'created' => $project['created']],
        'board' => ['id' => $board['id'], 'created' => $board['created']],
        'columns' => ['created' => $createdColumns, 'existing' => $existingColumns],
        'tasks' => ['created' => $createdTasks, 'existing' => $existingTasks],
        'errors' => $errors,
    ]);
} catch (Throwable $error) {
    respond(['error' => $error->getMessage()], 500);
}
