<?php
namespace Opencart\Catalog\Model\Extension\ApskaitaExport\Other;
/** SELECT-only queries over order, order_product, order_total, order_status and return. */
class ApskaitaExport extends \Opencart\System\Engine\Model {
	public function getOrders(string $since, int $afterId, int $limit, array $returnStatusIds): array {
		$s = $this->db->escape($since);
		$query = $this->db->query("SELECT o.order_id, o.store_id, o.store_name, o.invoice_no, o.invoice_prefix, o.firstname, o.lastname, o.email,
				o.payment_company, o.payment_address_1, o.payment_address_2, o.payment_city, o.payment_postcode, o.payment_country, o.payment_custom_field,
				o.total, o.order_status_id, os.name AS order_status, o.currency_code, o.currency_value, o.date_added, o.date_modified
			FROM `" . DB_PREFIX . "order` o
			LEFT JOIN `" . DB_PREFIX . "order_status` os ON (os.order_status_id = o.order_status_id AND os.language_id = '" . (int)$this->config->get('config_language_id') . "')
			WHERE o.order_status_id > '0' AND (o.date_modified > '" . $s . "' OR (o.date_modified = '" . $s . "' AND o.order_id > '" . (int)$afterId . "'))
			ORDER BY o.date_modified ASC, o.order_id ASC LIMIT " . (int)$limit);
		$orders = [];
		foreach ($query->rows as $row) {
			$id = (int)$row['order_id'];
			$row['products'] = $this->db->query("SELECT order_product_id, product_id, name, model, quantity, price, total, tax FROM `" . DB_PREFIX . "order_product` WHERE order_id = '" . $id . "' ORDER BY order_product_id")->rows;
			$row['totals'] = $this->db->query("SELECT code, title, value, sort_order FROM `" . DB_PREFIX . "order_total` WHERE order_id = '" . $id . "' ORDER BY sort_order")->rows;
			$row['returns'] = [];
			if ($returnStatusIds) {
				$row['returns'] = $this->db->query("SELECT return_id, product_id, product, model, quantity, return_status_id, date_modified FROM `" . DB_PREFIX . "return` WHERE order_id = '" . $id . "' AND return_status_id IN (" . implode(',', array_map('intval', $returnStatusIds)) . ")")->rows;
			}
			$orders[] = $row;
		}
		return $orders;
	}
}
