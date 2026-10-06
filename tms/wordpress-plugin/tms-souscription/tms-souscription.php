<?php
/**
 * Plugin Name: TMS — Souscription en ligne
 * Description: Intègre sur le site les offres, le configurateur de modules et l'inscription en ligne de l'application de gestion de centre de formation (shortcodes [tms_souscription], [tms_tarifs], [tms_modules], [tms_inscription]).
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: Sesame Technology
 * License: GPL-2.0-or-later
 * Text Domain: tms-souscription
 */

if (!defined('ABSPATH')) {
    exit;
}

const TMS_SOUSCRIPTION_OPTION = 'tms_souscription_settings';
const TMS_SOUSCRIPTION_CACHE = 'tms_souscription_catalog';

function tms_souscription_settings(): array
{
    $defaults = ['api_url' => '', 'accent' => '#2457d6', 'theme' => 'auto', 'source' => 'site-wordpress', 'jsonld' => 1];
    return wp_parse_args((array) get_option(TMS_SOUSCRIPTION_OPTION, []), $defaults);
}

/* ─── Réglages ─────────────────────────────────────────────────────────── */

add_action('admin_menu', function () {
    add_options_page('Souscription en ligne', 'Souscription en ligne', 'manage_options', 'tms-souscription', 'tms_souscription_settings_page');
});

add_action('admin_init', function () {
    register_setting('tms_souscription', TMS_SOUSCRIPTION_OPTION, [
        'type' => 'array',
        'sanitize_callback' => function ($in) {
            $in = (array) $in;
            delete_transient(TMS_SOUSCRIPTION_CACHE);
            return [
                'api_url' => esc_url_raw(rtrim($in['api_url'] ?? '', '/'), ['https', 'http']),
                'accent' => sanitize_hex_color($in['accent'] ?? '') ?: '#2457d6',
                'theme' => in_array($in['theme'] ?? '', ['auto', 'light', 'dark'], true) ? $in['theme'] : 'auto',
                'source' => sanitize_key($in['source'] ?? 'site-wordpress') ?: 'site-wordpress',
                'jsonld' => empty($in['jsonld']) ? 0 : 1,
            ];
        },
    ]);
});

function tms_souscription_settings_page()
{
    $s = tms_souscription_settings();
    $catalog = tms_souscription_catalog();
    ?>
    <div class="wrap">
        <h1>Souscription en ligne</h1>
        <p>Renseignez l'URL de l'API de l'application. Le domaine de ce site doit figurer dans <code>PUBLIC_ORIGINS</code> côté API.</p>
        <form method="post" action="options.php">
            <?php settings_fields('tms_souscription'); ?>
            <table class="form-table" role="presentation">
                <tr><th scope="row"><label for="tms_api">URL de l'API</label></th>
                    <td><input id="tms_api" class="regular-text" type="url" name="<?php echo esc_attr(TMS_SOUSCRIPTION_OPTION); ?>[api_url]" value="<?php echo esc_attr($s['api_url']); ?>" placeholder="https://api.exemple.fr" required></td></tr>
                <tr><th scope="row"><label for="tms_accent">Couleur d'accent</label></th>
                    <td><input id="tms_accent" type="text" name="<?php echo esc_attr(TMS_SOUSCRIPTION_OPTION); ?>[accent]" value="<?php echo esc_attr($s['accent']); ?>" pattern="#[0-9a-fA-F]{3,6}"></td></tr>
                <tr><th scope="row"><label for="tms_theme">Thème</label></th>
                    <td><select id="tms_theme" name="<?php echo esc_attr(TMS_SOUSCRIPTION_OPTION); ?>[theme]">
                        <?php foreach (['auto' => 'Automatique', 'light' => 'Clair', 'dark' => 'Sombre'] as $k => $l) : ?>
                            <option value="<?php echo esc_attr($k); ?>" <?php selected($s['theme'], $k); ?>><?php echo esc_html($l); ?></option>
                        <?php endforeach; ?>
                    </select></td></tr>
                <tr><th scope="row"><label for="tms_source">Étiquette d'origine</label></th>
                    <td><input id="tms_source" type="text" name="<?php echo esc_attr(TMS_SOUSCRIPTION_OPTION); ?>[source]" value="<?php echo esc_attr($s['source']); ?>"><p class="description">Enregistrée avec chaque inscription (suivi des conversions).</p></td></tr>
                <tr><th scope="row">Données structurées</th>
                    <td><label><input type="checkbox" name="<?php echo esc_attr(TMS_SOUSCRIPTION_OPTION); ?>[jsonld]" value="1" <?php checked($s['jsonld'], 1); ?>> Publier les offres en JSON-LD (schema.org Product/Offer)</label></td></tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <h2>État de la connexion</h2>
        <p><?php echo $catalog ? '✅ ' . esc_html(count($catalog['plans'])) . ' offres chargées.' : '⚠️ Catalogue indisponible : vérifiez l’URL de l’API.'; ?></p>
        <h2>Shortcodes</h2>
        <ul>
            <li><code>[tms_souscription]</code> — tarifs + modules + inscription</li>
            <li><code>[tms_tarifs interval="year"]</code> — grille tarifaire seule</li>
            <li><code>[tms_modules]</code> — présentation des modules</li>
            <li><code>[tms_inscription plan="equipe"]</code> — formulaire d'inscription (offre présélectionnée)</li>
        </ul>
    </div>
    <?php
}

/* ─── Catalogue (rendu serveur indexable + JSON-LD) ────────────────────── */

function tms_souscription_catalog(): ?array
{
    $s = tms_souscription_settings();
    if (!$s['api_url']) {
        return null;
    }
    $cached = get_transient(TMS_SOUSCRIPTION_CACHE);
    if (is_array($cached)) {
        return $cached;
    }
    $res = wp_remote_get($s['api_url'] . '/api/v1/public/catalog', ['timeout' => 5, 'headers' => ['Accept' => 'application/json']]);
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        return null;
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if (!is_array($data) || empty($data['plans'])) {
        return null;
    }
    set_transient(TMS_SOUSCRIPTION_CACHE, $data, HOUR_IN_SECONDS);
    return $data;
}

function tms_souscription_price($cents): string
{
    return number_format_i18n(((int) $cents) / 100, ((int) $cents) % 100 ? 2 : 0) . ' €';
}

/** Repli HTML lisible par les moteurs et sans JavaScript ; remplacé par le widget interactif. */
function tms_souscription_fallback(array $catalog, string $interval): string
{
    $html = '<div class="tms-fallback"><ul>';
    foreach ($catalog['plans'] as $p) {
        $price = $interval === 'year' ? $p['yearlyPriceCents'] : $p['monthlyPriceCents'];
        $period = $price ? ($interval === 'year' ? ' HT / an' : ' HT / mois') : '';
        $html .= '<li><strong>' . esc_html($p['name']) . '</strong> — ' . esc_html(tms_souscription_price($price) . $period) . ' : ' . esc_html($p['tagline']) . '</li>';
    }
    return $html . '</ul></div>';
}

function tms_souscription_jsonld(array $catalog): string
{
    $offers = [];
    foreach ($catalog['plans'] as $p) {
        $offers[] = [
            '@type' => 'Offer',
            'name' => $p['name'],
            'description' => $p['tagline'],
            'price' => number_format($p['monthlyPriceCents'] / 100, 2, '.', ''),
            'priceCurrency' => $catalog['currency'] ?? 'EUR',
            'priceSpecification' => [
                '@type' => 'UnitPriceSpecification',
                'price' => number_format($p['monthlyPriceCents'] / 100, 2, '.', ''),
                'priceCurrency' => $catalog['currency'] ?? 'EUR',
                'unitCode' => 'MON',
                'valueAddedTaxIncluded' => false,
            ],
            'availability' => 'https://schema.org/InStock',
        ];
    }
    $data = [
        '@context' => 'https://schema.org',
        '@type' => 'SoftwareApplication',
        'name' => get_bloginfo('name') . ' — gestion de centre de formation',
        'applicationCategory' => 'BusinessApplication',
        'operatingSystem' => 'Web',
        'offers' => ['@type' => 'AggregateOffer', 'lowPrice' => '0', 'priceCurrency' => $catalog['currency'] ?? 'EUR', 'offerCount' => count($offers), 'offers' => $offers],
    ];
    return '<script type="application/ld+json">' . wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '</script>';
}

/* ─── Shortcodes ───────────────────────────────────────────────────────── */

function tms_souscription_render(array $atts, string $show): string
{
    $s = tms_souscription_settings();
    if (!$s['api_url']) {
        return current_user_can('manage_options') ? '<p><em>Souscription en ligne : configurez l’URL de l’API (Réglages → Souscription en ligne).</em></p>' : '';
    }
    $atts = shortcode_atts(['plan' => '', 'interval' => 'month', 'title' => '', 'show' => $show], $atts);
    $interval = $atts['interval'] === 'year' ? 'year' : 'month';
    $plan = in_array($atts['plan'], ['free', 'solo', 'equipe', 'centre'], true) ? $atts['plan'] : '';
    $show = implode(',', array_intersect(array_map('trim', explode(',', $atts['show'])), ['pricing', 'modules', 'signup']));

    wp_enqueue_script('tms-embed', $s['api_url'] . '/embed/v1/tms-embed.js', [], '1', ['strategy' => 'defer', 'in_footer' => true]);

    $catalog = tms_souscription_catalog();
    $out = sprintf(
        '<div data-tms-widget data-api="%s" data-show="%s" data-interval="%s" data-accent="%s" data-theme="%s" data-source="%s"%s%s>%s</div>',
        esc_attr($s['api_url']), esc_attr($show ?: 'pricing,modules,signup'), esc_attr($interval), esc_attr($s['accent']), esc_attr($s['theme']),
        esc_attr($s['source']), $plan ? ' data-plan="' . esc_attr($plan) . '"' : '', $atts['title'] ? ' data-title="' . esc_attr($atts['title']) . '"' : '',
        $catalog && strpos($show, 'pricing') !== false ? tms_souscription_fallback($catalog, $interval) : ''
    );
    static $jsonld_done = false;
    if ($catalog && $s['jsonld'] && !$jsonld_done && strpos($show, 'pricing') !== false) {
        $out .= tms_souscription_jsonld($catalog);
        $jsonld_done = true;
    }
    return $out;
}

add_shortcode('tms_souscription', function ($atts) { return tms_souscription_render((array) $atts, 'pricing,modules,signup'); });
add_shortcode('tms_tarifs', function ($atts) { return tms_souscription_render((array) $atts, 'pricing'); });
add_shortcode('tms_modules', function ($atts) { return tms_souscription_render((array) $atts, 'modules'); });
add_shortcode('tms_inscription', function ($atts) { return tms_souscription_render((array) $atts, 'signup'); });

/** Mesure des conversions : relais des événements du widget vers dataLayer (GTM) si présent. */
add_action('wp_footer', function () {
    if (!wp_script_is('tms-embed', 'enqueued')) {
        return;
    }
    echo "<script>document.addEventListener('tms:signup',function(e){(window.dataLayer=window.dataLayer||[]).push({event:'tms_signup',tms_plan:e.detail.plan,tms_interval:e.detail.interval});});</script>";
});
