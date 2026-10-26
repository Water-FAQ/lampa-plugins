/* Compatibility entry point. Use shikimori.js for new installations. */
(function () {
    'use strict';
    if (window.plugin_shikimori_ready || window.waterfaq_shikimori_loading) return;
    window.waterfaq_shikimori_loading = true;
    var script = document.createElement('script');
    script.src = 'https://water-faq.github.io/lampa-plugins/shikimori.js';
    script.onload = function () { window.waterfaq_shikimori_loading = false; };
    script.onerror = function () { window.waterfaq_shikimori_loading = false; };
    (document.head || document.documentElement).appendChild(script);
}());
