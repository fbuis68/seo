<?php
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
delete_option('tms_souscription_settings');
delete_transient('tms_souscription_catalog');
