<?php
namespace Opencart\Admin\Controller\Extension\ApskaitaExport\Other;
/**
 * Apskaita order export – settings page (key generation, enable flag, optional IP allowlist,
 * completed return status ids). Installed via Extensions → Installer, then Extensions → Other.
 */
class ApskaitaExport extends \Opencart\System\Engine\Controller {
	public function index(): void {
		$this->load->language('extension/apskaita_export/other/apskaita_export');
		$this->document->setTitle($this->language->get('heading_title'));
		$token = 'user_token=' . $this->session->data['user_token'];
		$data['breadcrumbs'] = [
			['text' => $this->language->get('text_home'), 'href' => $this->url->link('common/dashboard', $token)],
			['text' => $this->language->get('text_extension'), 'href' => $this->url->link('marketplace/extension', $token . '&type=other')],
			['text' => $this->language->get('heading_title'), 'href' => $this->url->link('extension/apskaita_export/other/apskaita_export', $token)],
		];
		$data['save'] = $this->url->link('extension/apskaita_export/other/apskaita_export.save', $token);
		$data['back'] = $this->url->link('marketplace/extension', $token . '&type=other');
		$data['other_apskaita_export_status'] = $this->config->get('other_apskaita_export_status');
		$data['other_apskaita_export_key'] = $this->config->get('other_apskaita_export_key') ?: bin2hex(random_bytes(32));
		$data['other_apskaita_export_ips'] = $this->config->get('other_apskaita_export_ips');
		$data['other_apskaita_export_return_status_ids'] = $this->config->get('other_apskaita_export_return_status_ids');
		$data['endpoint'] = HTTP_CATALOG . 'index.php?route=extension/apskaita_export/other/apskaita_export';
		$data['header'] = $this->load->controller('common/header');
		$data['column_left'] = $this->load->controller('common/column_left');
		$data['footer'] = $this->load->controller('common/footer');
		$this->response->setOutput($this->load->view('extension/apskaita_export/other/apskaita_export', $data));
	}

	public function save(): void {
		$this->load->language('extension/apskaita_export/other/apskaita_export');
		$json = [];
		if (!$this->user->hasPermission('modify', 'extension/apskaita_export/other/apskaita_export')) {
			$json['error'] = $this->language->get('error_permission');
		}
		$key = (string)($this->request->post['other_apskaita_export_key'] ?? '');
		if (!$json && strlen($key) < 32) {
			$json['error'] = $this->language->get('error_key');
		}
		if (!$json) {
			$this->load->model('setting/setting');
			$this->model_setting_setting->editSetting('other_apskaita_export', [
				'other_apskaita_export_status' => (int)($this->request->post['other_apskaita_export_status'] ?? 0),
				'other_apskaita_export_key' => $key,
				'other_apskaita_export_ips' => (string)($this->request->post['other_apskaita_export_ips'] ?? ''),
				'other_apskaita_export_return_status_ids' => (string)($this->request->post['other_apskaita_export_return_status_ids'] ?? ''),
			]);
			$json['success'] = $this->language->get('text_success');
		}
		$this->response->addHeader('Content-Type: application/json');
		$this->response->setOutput(json_encode($json));
	}

	public function install(): void {}

	public function uninstall(): void {
		$this->load->model('setting/setting');
		$this->model_setting_setting->deleteSetting('other_apskaita_export');
	}
}
