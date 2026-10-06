<?php
// Minimal OpenCart 4 engine stubs to run the REAL extension controller/model under `php -S`.
// The DB stub answers the extension's SELECTs from fixtures/stores/opencart-orders.json.
// This verifies signature checking, pagination and output format – not a live OpenCart install.
namespace Opencart\System\Engine {
	class Controller { public $registry; public function __get($k) { return $this->registry->$k; } public function __construct($registry) { $this->registry = $registry; } }
	class Model { public $registry; public function __get($k) { return $this->registry->$k; } public function __construct($registry) { $this->registry = $registry; } }
}
namespace {
	define('DB_PREFIX', 'oc_');
	$fixture = json_decode(file_get_contents(getenv('OC_FIXTURE')), true);
	$state = json_decode(@file_get_contents(getenv('OC_STATE') ?: '/nonexistent') ?: '{}', true);
	if (!empty($state['orders'])) $fixture = $state['orders'];
	class Cfg { public $v; function __construct($v) { $this->v = $v; } function get($k) { return $this->v[$k] ?? null; } }
	class Req { public $get; public $server; function __construct() { $this->get = $_GET; $this->server = $_SERVER; } }
	class Resp { public $headers = []; public $out = ''; function addHeader($h) { $this->headers[] = $h; } function setOutput($o) { $this->out = $o; } }
	class Db {
		public $orders;
		function __construct($o) { $this->orders = $o; }
		function escape($s) { return addslashes($s); }
		function query($sql) {
			$r = new stdClass();
			if (preg_match("/FROM `oc_order` o/", $sql)) {
				preg_match("/o.date_modified > '([^']+)' OR \(o.date_modified = '[^']+' AND o.order_id > '(\d+)'\)\)/", $sql, $m);
				preg_match("/LIMIT (\d+)/", $sql, $l);
				$rows = array_values(array_filter($this->orders, fn($o) => $o['date_modified'] > $m[1] || ($o['date_modified'] === $m[1] && (int)$o['order_id'] > (int)$m[2])));
				usort($rows, fn($a, $b) => [$a['date_modified'], (int)$a['order_id']] <=> [$b['date_modified'], (int)$b['order_id']]);
				$r->rows = array_map(fn($o) => array_diff_key($o, ['products' => 1, 'totals' => 1, 'returns' => 1]), array_slice($rows, 0, (int)$l[1]));
			} else {
				preg_match("/order_id = '(\d+)'/", $sql, $m);
				$o = current(array_filter($this->orders, fn($x) => $x['order_id'] === $m[1]));
				$r->rows = str_contains($sql, 'order_product') ? $o['products'] : (str_contains($sql, 'order_total') ? $o['totals'] : ($o['returns'] ?? []));
			}
			return $r;
		}
	}
	class Loader { public $reg; function __construct($reg) { $this->reg = $reg; }
		function model($route) {
			require_once getenv('OC_EXT') . '/catalog/model/other/apskaita_export.php';
			$this->reg->{'model_' . str_replace('/', '_', $route)} = new \Opencart\Catalog\Model\Extension\ApskaitaExport\Other\ApskaitaExport($this->reg);
		}
	}
	$reg = new stdClass();
	$reg->config = new Cfg(['other_apskaita_export_status' => 1, 'other_apskaita_export_key' => getenv('OC_KEY'), 'other_apskaita_export_ips' => '', 'other_apskaita_export_return_status_ids' => '3', 'config_language_id' => 1]);
	$reg->request = new Req();
	$reg->response = new Resp();
	$reg->db = new Db($fixture);
	$reg->load = new Loader($reg);
	if (($_GET['route'] ?? '') !== 'extension/apskaita_export/other/apskaita_export') { http_response_code(404); echo '{}'; return; }
	require_once getenv('OC_EXT') . '/catalog/controller/other/apskaita_export.php';
	$c = new \Opencart\Catalog\Controller\Extension\ApskaitaExport\Other\ApskaitaExport($reg);
	$c->index();
	foreach ($reg->response->headers as $h) { if (str_starts_with($h, 'HTTP/1.1 ')) http_response_code((int)substr($h, 9, 3)); else header($h); }
	echo $reg->response->out;
}
