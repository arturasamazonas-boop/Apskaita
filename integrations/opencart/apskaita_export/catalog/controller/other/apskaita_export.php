<?php
namespace Opencart\Catalog\Controller\Extension\ApskaitaExport\Other;
/**
 * Read-only order export for Apskaita.
 * GET index.php?route=extension/apskaita_export/other/apskaita_export&since=YYYY-MM-DD HH:MM:SS&after_id=0&limit=50
 * Headers: X-Apskaita-Timestamp (unix seconds, ±300 s), X-Apskaita-Signature = hex HMAC-SHA256(key, timestamp . "\n" . since . "\n" . after_id . "\n" . limit)
 * Pagination is keyset-based on (date_modified, order_id) so imports are resumable and stable.
 */
class ApskaitaExport extends \Opencart\System\Engine\Controller {
	public function index(): void {
		$this->response->addHeader('Content-Type: application/json');
		$this->response->addHeader('Cache-Control: no-store');
		$error = $this->authenticate();
		if ($error) {
			$this->response->addHeader('HTTP/1.1 ' . $error[0]);
			$this->response->setOutput(json_encode(['error' => $error[1]]));
			return;
		}
		$since = (string)($this->request->get['since'] ?? '1970-01-01 00:00:00');
		$afterId = (int)($this->request->get['after_id'] ?? 0);
		$limit = max(1, min(200, (int)($this->request->get['limit'] ?? 50)));
		if (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $since)) {
			$this->response->addHeader('HTTP/1.1 400 Bad Request');
			$this->response->setOutput(json_encode(['error' => 'bad since']));
			return;
		}
		$this->load->model('extension/apskaita_export/other/apskaita_export');
		$returnStatusIds = array_filter(array_map('intval', explode(',', (string)$this->config->get('other_apskaita_export_return_status_ids'))));
		$orders = $this->model_extension_apskaita_export_other_apskaita_export->getOrders($since, $afterId, $limit + 1, $returnStatusIds);
		$hasMore = count($orders) > $limit;
		$orders = array_slice($orders, 0, $limit);
		$last = end($orders);
		$this->response->setOutput(json_encode([
			'api_version' => 1,
			'orders' => $orders,
			'has_more' => $hasMore,
			'next' => $last ? ['since' => $last['date_modified'], 'after_id' => (int)$last['order_id']] : null,
		]));
	}

	private function authenticate(): ?array {
		if (!$this->config->get('other_apskaita_export_status')) return ['404 Not Found', 'disabled'];
		$key = (string)$this->config->get('other_apskaita_export_key');
		if (strlen($key) < 32) return ['503 Service Unavailable', 'not configured'];
		$ips = array_filter(array_map('trim', preg_split('/\R/', (string)$this->config->get('other_apskaita_export_ips'))));
		if ($ips && !in_array($this->request->server['REMOTE_ADDR'] ?? '', $ips, true)) return ['403 Forbidden', 'ip'];
		$ts = (string)($this->request->server['HTTP_X_APSKAITA_TIMESTAMP'] ?? '');
		$sig = (string)($this->request->server['HTTP_X_APSKAITA_SIGNATURE'] ?? '');
		if (!ctype_digit($ts) || abs(time() - (int)$ts) > 300) return ['401 Unauthorized', 'timestamp'];
		$payload = $ts . "\n" . (string)($this->request->get['since'] ?? '1970-01-01 00:00:00') . "\n" . (string)($this->request->get['after_id'] ?? '0') . "\n" . (string)($this->request->get['limit'] ?? '50');
		if (!hash_equals(hash_hmac('sha256', $payload, $key), strtolower($sig))) return ['401 Unauthorized', 'signature'];
		return null;
	}
}
