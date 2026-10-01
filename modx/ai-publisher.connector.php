<?php
/**
 * ai-publisher.connector.php — точка приёма публикаций от AI-агента для MODX Revolution 2.8.x
 *
 * ЗАЧЕМ
 * Агент генерирует черновики страниц и статей. Этот коннектор позволяет ему
 * создавать и обновлять ресурсы MODX штатными процессорами (resource/create,
 * resource/update), поэтому шаблоны, чанки, TV и кеш работают как обычно,
 * а агенту не нужно знать ни одного чанка наизусть.
 *
 * КАК ПОСТАВИТЬ (5 минут)
 * 1. Загрузи этот файл на сервер, например:
 *      /assets/components/aipublisher/connector.php
 *    Имя каталога можно поменять на любое неприметное — это дополнительный
 *    слой скрытности. Права на файл: 644, на каталог 755.
 * 2. В админке MODX: Система → Настройки → создать настройку:
 *      ключ:   ai_publisher_token
 *      тип:    Text
 *      значение: длинная случайная строка (сгенерируй, например,
 *                openssl rand -hex 24 или PowerShell-командой из README)
 *    Настройку положи в отдельную область «API», чтобы не потерять.
 * 3. Проверь:
 *      curl -H "Authorization: Bearer ТОКЕН" https://rocket-up.space/assets/components/aipublisher/connector.php?action=ping
 *    Ожидаемый ответ: {"success":true,"modx_version":"2.8.8-pl",...}
 * 4. Добавь на Render переменные:
 *      MODX_PUBLISHER_URL=https://rocket-up.space/assets/components/aipublisher/connector.php
 *      MODX_PUBLISHER_TOKEN=тот же токен
 *
 * БЕЗОПАСНОСТЬ
 * - Без верного токена коннектор отвечает 401 и ничего не делает.
 * - Мутации (create/update/publish) принимаются только POST-запросом.
 * - Токен хранится в настройке MODX, а не в файле: файл можно спокойно
 *   заливать в git и показывать подрядчику.
 * - Все входные данные проходят через процессоры MODX, которые сами
 *   экранируют и валидируют поля; содержимое ресурса сохраняется как есть
 *   (это осознанно: агент присылает готовый HTML/Markdown-разметку).
 *
 * ПОЛИТИКА БЕЗОПАСНОСТИ
 * По умолчанию действует режим create_only: агент создаёт новые ресурсы
 * (черновиками) и может публиковать только созданное им самим. Изменение
 * или публикация УЖЕ существующих страниц отклоняются с 403 — даже при
 * верном токене. Переключить режим можно настройкой MODX ai_publisher_mode=full,
 * и это осознанное решение владельца, а не агента.
 * Действия delete в коннекторе нет и не будет.
 *
 * ДОНОРСКИЙ РЕСУРС ВМЕСТО ПЕРЕЧИСЛЕНИЯ ЧАНКОВ
 * У страниц услуг разные шаблоны и наборы TV. Перечислять их не нужно:
 * при создании передай donorId — ID существующей похожей страницы. Коннектор
 * возьмёт с неё шаблон и значения TV (кроме перечисленных в payload),
 * то есть новая страница унаследует структуру донора, а агент подставит
 * только тексты и мета-поля.
 */

define('MODX_API_MODE', true);

// --- Бутстрап ядра MODX из произвольной точки сайта ---
$corePath = null;
foreach ([
    dirname(dirname(dirname(dirname(__FILE__)))) . '/config.core.php', // /assets/components/aipublisher/ → корень
    dirname(dirname(dirname(__FILE__))) . '/config.core.php',
    dirname(dirname(__FILE__)) . '/config.core.php',
] as $candidate) {
    if (is_file($candidate)) {
        $corePath = $candidate;
        break;
    }
}

if ($corePath === null) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Не найден config.core.php: проверь, что файл лежит внутри сайта MODX'], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once $corePath;
if (!defined('MODX_CORE_PATH') || !is_file(MODX_CORE_PATH . 'model/modx/modx.class.php')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'MODX_CORE_PATH не определён'], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once MODX_CORE_PATH . 'model/modx/modx.class.php';

$modx = new modX();
$modx->initialize('web');
$modx->getService('error', 'error.modError');
// Не шумим в лог браузера и не ломаем JSON предупреждениями
$modx->setLogLevel(modX::LOG_LEVEL_ERROR);

header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');

function respond($modx, $status, $payload)
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// --- Авторизация ---
$expectedToken = $modx->getOption('ai_publisher_token', null, '');
$provided = '';

if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $provided = trim((string) preg_replace('/^Bearer\s+/i', '', $_SERVER['HTTP_AUTHORIZATION']));
} elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
    $provided = trim((string) preg_replace('/^Bearer\s+/i', '', $_SERVER['REDIRECT_HTTP_AUTHORIZATION']));
}

if ($expectedToken === '' || !is_string($provided) || $provided === '' || !hash_equals($expectedToken, $provided)) {
    respond($modx, 401, [
        'success' => false,
        'error' => $expectedToken === ''
            ? 'На сервере не задана настройка MODX ai_publisher_token'
            : 'Неверный токен',
    ]);
}

/*
 * ПОЛИТИКА БЕЗОПАСНОСТИ (жёсткая, на стороне сервера)
 *
 * ai_publisher_mode:
 *   create_only (по умолчанию, действует и когда настройка отсутствует) —
 *       агент может СОЗДАВАТЬ новые ресурсы и публиковать ТОЛЬКО созданные им самим;
 *       изменение и публикация уже существующего контента отклоняются с 403.
 *   full —
 *       разрешает update/publish любых ресурсов. Включается только осознанно,
 *       когда владельцу действительно нужно пакетное обновление.
 *
 * Владение помечается в properties ресурса при создании, поэтому защита
 * переживает рестарты и не зависит от памяти процесса.
 */
$mode = $modx->getOption('ai_publisher_mode', null, 'create_only');
if ($mode !== 'full') {
    $mode = 'create_only';
}

function isAgentOwned($resource)
{
    $properties = $resource->get('properties');
    if (is_string($properties)) {
        $properties = json_decode($properties, true);
    }
    return is_array($properties) && isset($properties['ai_publisher']);
}

function markAgentOwned($resource, $taskId)
{
    $properties = $resource->get('properties');
    if (is_string($properties)) {
        $properties = json_decode($properties, true);
    }
    if (!is_array($properties)) {
        $properties = [];
    }
    $properties['ai_publisher'] = [
        'created_at' => date('c'),
        'task' => (string) $taskId,
    ];
    $resource->set('properties', $properties);
    return $resource->save();
}

function guardExisting($modx, $mode, $resource, $action)
{
    if ($mode === 'full' || isAgentOwned($resource)) {
        return null;
    }
    return [
        'success' => false,
        'error' => 'Политика безопасности: изменение или публикация существующего контента '
            . 'запрещены (ai_publisher_mode=create_only). Действие "' . $action . '" отклонено. '
            . 'Запроси согласование у владельца: агент создаст заявку, владелец одобрит её '
            . 'командой /approve в Telegram, после чего действие выполнится.',
        'policy' => 'create_only',
    ];
}

$action = isset($_GET['action']) ? (string) $_GET['action'] : 'ping';
$method = $_SERVER['REQUEST_METHOD'];

$rawInput = file_get_contents('php://input');
$payload = $rawInput ? json_decode($rawInput, true) : [];
if (!is_array($payload)) {
    $payload = [];
}

// --- Чтения: только GET ---
if ($action === 'ping') {
    respond($modx, 200, [
        'success' => true,
        // getVersionData()['version'] отдаёт только мажорную цифру («2»),
        // поэтому шлём полную строку версии ядра
        'modx_version' => $modx->version ?? ($modx->getVersionData()['full_version'] ?? 'unknown'),
        'site_url' => $modx->getOption('site_url'),
        'mode' => $mode,
        'time' => date('c'),
    ]);
}

if ($action === 'templates') {
    $templates = $modx->getCollection('modTemplate');
    $list = [];
    foreach ($templates as $template) {
        $list[] = ['id' => $template->get('id'), 'name' => $template->get('templatename')];
    }
    respond($modx, 200, ['success' => true, 'templates' => $list]);
}

if ($action === 'resource') {
    $id = (int) ($payload['id'] ?? ($_GET['id'] ?? 0));
    $resource = $modx->getObject('modResource', $id);
    if (!$resource) {
        respond($modx, 404, ['success' => false, 'error' => "Ресурс $id не найден"]);
    }

    $tvs = [];
    foreach ($resource->getTemplateVars() as $tv) {
        $tvs[$tv->get('name')] = $tv->getOutputValue($resource);
    }

    respond($modx, 200, [
        'success' => true,
        'resource' => [
            'id' => $resource->get('id'),
            'pagetitle' => $resource->get('pagetitle'),
            'longtitle' => $resource->get('longtitle'),
            'description' => $resource->get('description'),
            'alias' => $resource->get('alias'),
            'template' => $resource->get('template'),
            'parent' => $resource->get('parent'),
            'published' => (bool) $resource->get('published'),
            'agentOwned' => isAgentOwned($resource),
            'tvs' => $tvs,
        ],
    ]);
}

// --- Мутации: только POST ---
if ($method !== 'POST') {
    respond($modx, 405, ['success' => false, 'error' => 'Действие доступно только методом POST']);
}

/**
 * Собирает поля ресурса из payload, опционально подмешивая шаблон и TV донора.
 */
function buildResourceData($modx, array $payload)
{
    $data = [
        'pagetitle'   => (string) ($payload['pagetitle'] ?? ''),
        'longtitle'   => (string) ($payload['longtitle'] ?? ''),
        'description' => (string) ($payload['description'] ?? ''),
        'introtext'   => (string) ($payload['introtext'] ?? ''),
        'content'     => (string) ($payload['content'] ?? ''),
        'alias'       => (string) ($payload['alias'] ?? ''),
        'parent'      => (int) ($payload['parent'] ?? $modx->getOption('site_start', null, 1)),
        'published'   => (int) ($payload['published'] ?? 0),
        'searchable'  => 1,
        'cacheable'   => 1,
        'richtext'    => (int) ($payload['richtext'] ?? 0),
        'hidemenu'    => (int) ($payload['hidemenu'] ?? 0),
    ];

    if ($payload['pagetitle'] === '' || $payload['pagetitle'] === null) {
        return ['error' => 'Не задан pagetitle'];
    }

    // Шаблон: явно из payload, иначе с донора, иначе шаблон родителя
    $template = isset($payload['template']) ? (int) $payload['template'] : null;
    $donorTvs = [];

    if (!empty($payload['donorId'])) {
        $donor = $modx->getObject('modResource', (int) $payload['donorId']);
        if (!$donor) {
            return ['error' => 'Донорский ресурс не найден: ' . (int) $payload['donorId']];
        }
        if ($template === null) {
            $template = (int) $donor->get('template');
        }
        foreach ($donor->getTemplateVars() as $tv) {
            $donorTvs[$tv->get('name')] = $tv->getOutputValue($donor);
        }
    }

    if ($template === null) {
        $parent = $modx->getObject('modResource', $data['parent']);
        $template = $parent ? (int) $parent->get('template') : (int) $modx->getOption('default_template');
    }

    $data['template'] = $template;

    // TV: сначала значения донора, поверх — явно переданные агентом
    $tvs = $donorTvs;
    if (!empty($payload['tvs']) && is_array($payload['tvs'])) {
        foreach ($payload['tvs'] as $name => $value) {
            $tvs[(string) $name] = $value;
        }
    }
    $data['tvs'] = $tvs;

    return ['data' => $data];
}

if ($action === 'create') {
    $built = buildResourceData($modx, $payload);
    if (isset($built['error'])) {
        respond($modx, 422, ['success' => false, 'error' => $built['error']]);
    }
    $data = $built['data'];
    $tvs = $data['tvs'];
    unset($data['tvs']);

    $response = $modx->runProcessor('resource/create', $data);
    if ($response->isError()) {
        respond($modx, 422, ['success' => false, 'error' => $response->getAllErrorMessages()]);
    }

    $created = $modx->getObject('modResource', (int) $response->getObject()['id']);
    foreach ($tvs as $name => $value) {
        $created->setTVValue((string) $name, $value);
    }
    markAgentOwned($created, $payload['taskId'] ?? '');
    $modx->cacheManager->refresh();
    $resource = $created;

    respond($modx, 200, [
        'success' => true,
        'id' => (int) $resource['id'],
        'alias' => $resource['alias'],
        'url' => $modx->makeUrl((int) $resource['id'], '', '', 'full'),
    ]);
}

if ($action === 'update') {
    $id = (int) ($payload['id'] ?? 0);
    $existing = $id > 0 ? $modx->getObject('modResource', $id) : null;
    if (!$existing) {
        respond($modx, 404, ['success' => false, 'error' => "Ресурс $id не найден"]);
    }

    $denied = guardExisting($modx, $mode, $existing, 'update');
    if ($denied !== null) {
        respond($modx, 403, $denied);
    }

    $built = buildResourceData($modx, ['pagetitle' => 'x'] + $payload); // pagetitle-заглушка: при update поля опциональны
    if (isset($built['error'])) {
        respond($modx, 422, ['success' => false, 'error' => $built['error']]);
    }
    $data = $built['data'];
    $tvs = $data['tvs'];
    unset($data['tvs']);
    // Убираем пустые поля, чтобы не затереть существующие значения
    $data = array_filter($data, function ($value, $key) {
        return $value !== '' || in_array($key, ['published', 'hidemenu', 'richtext'], true);
    }, ARRAY_FILTER_USE_BOTH);
    $data['id'] = $id;

    $response = $modx->runProcessor('resource/update', $data);
    if ($response->isError()) {
        respond($modx, 422, ['success' => false, 'error' => $response->getAllErrorMessages()]);
    }

    $resource = $modx->getObject('modResource', $id);
    foreach ($tvs as $name => $value) {
        if ($value !== '') {
            $resource->setTVValue((string) $name, $value);
        }
    }
    $modx->cacheManager->refresh();

    respond($modx, 200, [
        'success' => true,
        'id' => $id,
        'url' => $modx->makeUrl($id, '', '', 'full'),
    ]);
}

if ($action === 'publish') {
    $id = (int) ($payload['id'] ?? 0);
    $resource = $modx->getObject('modResource', $id);
    if (!$resource) {
        respond($modx, 404, ['success' => false, 'error' => "Ресурс $id не найден"]);
    }

    $denied = guardExisting($modx, $mode, $resource, 'publish');
    if ($denied !== null) {
        respond($modx, 403, $denied);
    }

    $resource->set('published', (int) ($payload['published'] ?? 1));
    $resource->set('publishedon', time());
    if (!$resource->save()) {
        respond($modx, 500, ['success' => false, 'error' => 'Не удалось сохранить ресурс']);
    }
    $modx->cacheManager->refresh();

    respond($modx, 200, ['success' => true, 'id' => $id, 'published' => (bool) $resource->get('published')]);
}

respond($modx, 400, ['success' => false, 'error' => "Неизвестное действие: $action"]);
