/* Ratings for Lampa, 0.3.1.
 * Uses Lampa's native CUB metadata source to preload ratings by exact TMDB ID.
 * No IMDb/Kinopoisk APIs, title searches or script downloads.
 */
(function () {
    'use strict';
    if (window.waterfaq_ratings) return;
    window.waterfaq_ratings = {version: '0.3.1'};

    var CACHE = 'wf_ratings_native_v1';
    var DAY = 86400000;
    var cache = {};
    var cards = [];
    var views = [];
    var started = false;
    var saveTimer, cleanTimer;
    var names = ['tmdb', 'imdb', 'kp'];
    var queue = [], pending = {}, retryUntil = {}, revisions = {};
    var running = 0, generation = 0, pumpTimer, intersection;

    function setting(name, fallback) { return Lampa.Storage.get('wf_ratings_' + name, fallback); }
    function rating(value) {
        if (typeof value !== 'number' && typeof value !== 'string') return 0;
        var text = String(value).trim().replace(',', '.');
        if (!/^\d+(\.\d+)?$/.test(text)) return 0;
        var n = Number(text);
        return isFinite(n) && n > 0 && n <= 10 ? n : 0;
    }
    function format(n) { return n === 10 ? '10' : n.toFixed(1); }
    function connected(node) { return !!node && document.documentElement.contains(node); }
    function type(data) {
        if (data.media_type === 'movie' || data.media_type === 'tv') return data.media_type;
        if (data.first_air_date) return 'tv';
        if (data.release_date) return 'movie';
        return data.original_name || (data.name && !data.title) ? 'tv' : 'movie';
    }
    function key(data, method) {
        var source = String(data.source || 'tmdb');
        if (source === 'cub') source = 'tmdb';
        return source + ':' + (method || type(data)) + ':' + String(data.id);
    }
    function valid(data) {
        if (!data || typeof data !== 'object') return null;
        if (data.data && !data.id) data = data.data;
        if (data.movie && !data.id) data = data.movie;
        return data && data.id && (data.title || data.name) && data.media_type !== 'person' && !data.known_for_department && data.source !== 'shikimori' ? data : null;
    }
    function cardData(node) {
        if (node.classList.contains('LMEShikimori')) return null;
        var candidates = [node.card_data, node._card, node.card, node.data];
        for (var i = 0; i < candidates.length; i++) {
            var found = valid(candidates[i]);
            if (found) return found;
        }
        if (window.$) {
            try {
                var jq = $(node), fields = ['card_data', 'card', 'item', 'data'];
                for (i = 0; i < fields.length; i++) {
                    found = valid(jq.data(fields[i]));
                    if (found) return found;
                }
            } catch (e) { /* Custom cards need not use jQuery data(). */ }
        }
        return null;
    }
    function extract(data) {
        var result = {}, fields = {tmdb: 'vote_average', imdb: 'imdb_rating', kp: 'kp_rating'};
        names.forEach(function (source) {
            if (Object.prototype.hasOwnProperty.call(data, fields[source])) result[source] = rating(data[fields[source]]);
        });
        return result;
    }
    function cached(id, source) {
        var entry = cache[id] && cache[id][source];
        return entry && Date.now() - entry.time < DAY ? entry : null;
    }
    function values(data, id) {
        var result = extract(data);
        names.forEach(function (source) {
            var entry = cached(id, source);
            if (entry) result[source] = entry.value;
        });
        return result;
    }
    function selected(data, id) {
        var scores = values(data, id);
        var priority = setting('priority', 'imdb');
        var order = priority === 'kp' ? ['kp', 'imdb', 'tmdb'] : priority === 'tmdb' ? ['tmdb', 'imdb', 'kp'] : ['imdb', 'kp', 'tmdb'];
        for (var i = 0; i < order.length; i++) if (rating(scores[order[i]])) return scores[order[i]];
        return 0;
    }
    function merge(id, incoming, full) {
        var changed = false, record = cache[id] || {};
        names.forEach(function (source) {
            if (!Object.prototype.hasOwnProperty.call(incoming, source)) return;
            var prev = cached(id, source), n = rating(incoming[source]);
            if (!full && prev && prev.full) return;
            if (!prev || prev.value !== n || (full && !prev.full)) {
                record[source] = {value: n, time: Date.now(), full: !!full};
                changed = true;
            }
        });
        if (changed) { cache[id] = record; save(); }
        return changed;
    }
    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            var ids = Object.keys(cache);
            ids.sort(function (a, b) { return latest(cache[b]) - latest(cache[a]); });
            ids.forEach(function (id, index) { if (index >= 1000 || Date.now() - latest(cache[id]) >= DAY) delete cache[id]; });
            try { Lampa.Storage.set(CACHE, cache); } catch (e) { /* Keep the session cache if storage is full. */ }
        }, 350);
    }
    function latest(record) {
        var time = Number(record && record.checked) || 0;
        names.forEach(function (source) { if (record && record[source]) time = Math.max(time, Number(record[source].time) || 0); });
        return time;
    }
    function visible(node) {
        if (!connected(node)) return false;
        var rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > -250 && rect.right > -250 && rect.top < window.innerHeight + 250 && rect.left < window.innerWidth + 250;
    }
    function needsLoad(data, id) {
        var source = data.source || 'tmdb';
        if ((source !== 'tmdb' && source !== 'cub') || !/^\d+$/.test(String(data.id))) return false;
        if (retryUntil[id] > Date.now()) return false;
        if (rating(values(data, id)[setting('priority', 'imdb')])) return false;
        return !(cache[id] && Date.now() - cache[id].checked < DAY);
    }
    function preload(node) {
        if (!visible(node)) return;
        var data = cardData(node);
        if (!data) return;
        var id = key(data);
        if (!needsLoad(data, id)) return;
        if (pending[id]) {
            if (pending[id].nodes.indexOf(node) === -1) pending[id].nodes.push(node);
            return;
        }
        var job = {id: id, movie: String(data.id), method: type(data), source: data.source || 'tmdb', nodes: [node], generation: generation};
        pending[id] = job;
        queue.push(job);
        clearTimeout(pumpTimer);
        pumpTimer = setTimeout(pump, 50);
    }
    function wanted(job) {
        return job.nodes.some(function (node) {
            var data = visible(node) && cardData(node);
            return data && key(data) === job.id && needsLoad(data, job.id);
        });
    }
    function metadata(job, done) {
        var network, timer, finished = false;
        function finish(json, error) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done(json, error);
        }
        try {
            if (!Lampa.TMDB || typeof Lampa.TMDB.api !== 'function' || typeof Lampa.TMDB.key !== 'function' || !Lampa.Reguest) throw new Error('Metadata API unavailable');
            var language = Lampa.Storage.get('tmdb_lang', Lampa.Storage.get('language', 'ru'));
            var imageLanguage = String(language || 'ru').split(/[-_]/)[0];
            // Match Lampa's primary full-metadata request. CUB enrichment is not
            // present in the stripped-down response with only external_ids.
            var path = job.method + '/' + encodeURIComponent(job.movie) + '?api_key=' + encodeURIComponent(Lampa.TMDB.key()) + '&language=' + encodeURIComponent(language) + '&append_to_response=content_ratings,release_dates,external_ids,keywords,alternative_titles,images&include_image_language=' + encodeURIComponent(imageLanguage + ',en,null');
            var url;
            // The native CUB metadata response contains IMDb/KP; the ordinary
            // TMDB proxy often returns only TMDB. Both use the same TMDB IDs.
            if (Lampa.Manifest && Lampa.Manifest.cub_domain) {
                var protocol = Lampa.Utils && Lampa.Utils.protocol ? Lampa.Utils.protocol() : 'https://';
                var account = Lampa.Storage.get('account', {});
                if (typeof account === 'string') { try { account = JSON.parse(account); } catch (e) { account = {}; } }
                url = protocol + 'tmdb.' + Lampa.Manifest.cub_domain + '/3/' + path + '&email=' + encodeURIComponent(account && account.email || '');
            } else url = Lampa.TMDB.api(path);
            network = new Lampa.Reguest();
            timer = setTimeout(function () { finish(null, true); network.clear(); }, 15000);
            network.timeout(12000);
            network.silent(url, function (json) { finish(json, false); }, function () { finish(null, true); });
        } catch (e) { finish(null, true); }
    }
    function pump() {
        clearTimeout(pumpTimer);
        while (running < 2 && queue.length) {
            var job = queue.shift();
            if (!wanted(job)) { if (pending[job.id] === job) delete pending[job.id]; continue; }
            execute(job);
        }
    }
    function execute(job) {
        running++;
        var revision = revisions[job.id] || 0;
        metadata(job, function (json, error) {
            running--;
            if (pending[job.id] === job) delete pending[job.id];
            if (job.generation === generation) {
                // A later native full-card update takes precedence over this response.
                if (error || !json || String(json.id) !== job.movie || (json.media_type && json.media_type !== job.method)) retryUntil[job.id] = Date.now() + 5 * 60000;
                else if ((revisions[job.id] || 0) === revision) {
                    var incoming = extract(json);
                    // A successful metadata response also confirms absent ratings.
                    if (!Object.prototype.hasOwnProperty.call(incoming, 'imdb')) incoming.imdb = 0;
                    if (!Object.prototype.hasOwnProperty.call(incoming, 'kp')) incoming.kp = 0;
                    merge(job.id, incoming, true);
                    if (!cache[job.id]) cache[job.id] = {};
                    cache[job.id].checked = Date.now();
                    save();
                    updateCards(job.id);
                }
            }
            pumpTimer = setTimeout(pump, 120);
        });
    }
    function color(n) {
        if (setting('scale', 'detailed') === 'simple') return n < 5 ? '#E57373' : n < 7 ? '#999999' : '#81C784';
        return n < 5 ? '#E57373' : n < 7 ? '#FFB74D' : n < 8 ? '#64B5F6' : '#81C784';
    }
    function paint(node, n, enabled) {
        if (!node) return;
        if (enabled && n) {
            if (!node._wfOriginalColor) node._wfOriginalColor = [node.style.getPropertyValue('color'), node.style.getPropertyPriority('color')];
            var desired = color(n);
            if (node._wfColor !== desired || node.style.color !== node._wfAppliedColor) node.style.setProperty('color', desired, 'important');
            node._wfColor = desired;
            node._wfAppliedColor = node.style.color;
        } else if (node._wfOriginalColor) {
            node.style.removeProperty('color');
            if (node._wfOriginalColor[0]) node.style.setProperty('color', node._wfOriginalColor[0], node._wfOriginalColor[1]);
            delete node._wfOriginalColor;
            delete node._wfColor;
            delete node._wfAppliedColor;
        }
    }
    function drawCard(node) {
        var data = cardData(node), badge = node.querySelector('.wf-ratings-vote');
        if (!data) {
            node.classList.remove('wf-ratings-owned');
            if (badge) badge.classList.add('hide');
            var nativeBadge = node.querySelector('.card__vote');
            if (nativeBadge) paint(nativeBadge, rating(nativeBadge.textContent), setting('list_color', true));
            return;
        }
        var id = key(data);
        var n = selected(data, id);
        if (!n) {
            node.classList.remove('wf-ratings-owned');
            if (badge) badge.classList.add('hide');
            return;
        }
        if (!badge) {
            var container = node.querySelector('.card__view');
            if (!container) return;
            badge = document.createElement('div');
            badge.className = 'wf-ratings-vote';
            container.appendChild(badge);
        }
        if (badge.textContent !== format(n)) badge.textContent = format(n);
        badge.classList.remove('hide');
        node.classList.add('wf-ratings-owned');
        paint(badge, n, setting('list_color', true));
    }
    function updateCards(id) {
        cards.forEach(function (node) {
            if (!connected(node)) return;
            var data = cardData(node);
            if (!id || (data && key(data) === id)) drawCard(node);
        });
    }
    function bindCard(node) {
        if (!node._wfNativeRatingsBound) {
            node._wfNativeRatingsBound = true;
            var update = function () {
                var data = cardData(node);
                if (data && merge(key(data), extract(data), false)) updateCards(key(data));
                drawCard(node);
                preload(node);
            };
            node.addEventListener('visible', update);
            node.addEventListener('hover:focus', update);
            node.addEventListener('update', update);
            // A few custom builders attach card_data after insertion, without a DOM change.
            [100, 400, 1000].forEach(function (delay) { setTimeout(function () { if (connected(node)) update(); }, delay); });
        }
        if (cards.indexOf(node) === -1) cards.push(node);
        if (intersection) intersection.observe(node);
        var data = cardData(node);
        if (data && merge(key(data), extract(data), false)) updateCards(key(data));
        drawCard(node);
        preload(node);
    }
    function colorLine(line) {
        var badges = line.querySelectorAll('.full-start__rate');
        for (var i = 0; i < badges.length; i++) {
            var value = badges[i].firstElementChild;
            if (value) paint(value, rating(value.textContent), setting('full_color', true));
        }
        // No text, labels, visibility or order is changed in the full card.
    }
    function syncView(view) {
        if (view.root._wfNativeRatingsView !== view || !connected(view.root)) return;
        var line = view.root.querySelector('.full-start-new__rate-line, .full-start__rate-line');
        if (!line) return;
        var incoming = extract(view.data);
        names.forEach(function (source) {
            var badge = line.querySelector('.rate--' + source);
            if (!badge) return;
            var node = badge.firstElementChild;
            var n = rating(node && node.textContent);
            if (n && !badge.classList.contains('hide')) {
                incoming[source] = n;
                view.observed[source] = true;
            } else if (view.observed[source]) incoming[source] = 0;
        });
        if (merge(view.id, incoming, true)) {
            revisions[view.id] = (revisions[view.id] || 0) + 1;
            updateCards(view.id);
        }
        if (incoming.imdb !== undefined || incoming.kp !== undefined) {
            if (!cache[view.id]) cache[view.id] = {};
            if (!cache[view.id].checked || Date.now() - cache[view.id].checked >= DAY) { cache[view.id].checked = Date.now(); save(); }
        }
        colorLine(line);
        bindLine(line, view);
    }
    function bindLine(line, view) {
        if (!view) {
            var parent = line.parentNode;
            while (parent && !view) { view = parent._wfNativeRatingsView; parent = parent.parentNode; }
        }
        if (view) line._wfNativeRatingsView = view;
        if (!line._wfNativeRatingsObserver) {
            var timer;
            line._wfNativeRatingsObserver = new MutationObserver(function () {
                // Mutation observers run before paint: color new/changed values
                // immediately, while leaving cache/poster updates debounced.
                colorLine(line);
                clearTimeout(timer);
                timer = setTimeout(function () {
                    var current = line._wfNativeRatingsView;
                    if (current) syncView(current);
                    else colorLine(line);
                }, 40);
            });
            line._wfNativeRatingsObserver.observe(line, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class']});
        }
        colorLine(line);
    }
    function onFull(e) {
        if (e.type !== 'complite' && e.type !== 'complete') return;
        var object = e.object || {}, activity = object.activity;
        var rendered = e.body || (activity && activity.render && activity.render());
        var root = rendered && (rendered[0] || rendered);
        var data = e.data && e.data.movie || object.movie || object.card;
        if (!root || !root.querySelector || !data || !data.id) return;
        var method = object.method === 'tv' || object.method === 'movie' ? object.method : type(data);
        var view = {root: root, data: data, id: key(data, method), observed: {}};
        root._wfNativeRatingsView = view;
        views = views.filter(function (old) { return connected(old.root) && old.root !== root; });
        views.push(view);
        syncView(view);
        // The complete event can precede the activity's insertion into the document.
        setTimeout(function () { syncView(view); }, 0);
    }
    function discover(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.matches('.card')) bindCard(root);
        else if (root.matches('.card__vote')) {
            var parent = root.closest ? root.closest('.card') : null;
            if (parent) bindCard(parent);
        }
        var found = root.querySelectorAll('.card');
        for (var i = 0; i < found.length; i++) bindCard(found[i]);
        if (root.matches('.full-start-new__rate-line, .full-start__rate-line')) {
            bindLine(root);
            if (root._wfNativeRatingsView) syncView(root._wfNativeRatingsView);
        }
        found = root.querySelectorAll('.full-start-new__rate-line, .full-start__rate-line');
        for (i = 0; i < found.length; i++) {
            bindLine(found[i]);
            if (found[i]._wfNativeRatingsView) syncView(found[i]._wfNativeRatingsView);
        }
    }
    function clean() {
        cards = cards.filter(function (node) {
            if (connected(node)) return true;
            if (intersection) intersection.unobserve(node);
            return false;
        });
        views = views.filter(function (view) { return connected(view.root); });
    }
    function refresh() {
        clean();
        views.forEach(syncView);
        updateCards();
        cards.forEach(preload);
        var lines = document.querySelectorAll('.full-start-new__rate-line, .full-start__rate-line');
        for (var i = 0; i < lines.length; i++) colorLine(lines[i]);
    }
    function settings() {
        Lampa.SettingsApi.addComponent({component: 'wf_ratings', name: 'Рейтинг', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>'});
        function add(name, type, title, options, fallback) {
            Lampa.SettingsApi.addParam({component: 'wf_ratings', param: {name: 'wf_ratings_' + name, type: type, values: options, default: fallback},
                field: {name: title}, onChange: function () { setTimeout(refresh, 0); }});
        }
        add('priority', 'select', 'Приоритет рейтинга', {imdb: 'IMDb', kp: 'Кинопоиск', tmdb: 'TMDB'}, 'imdb');
        add('list_color', 'trigger', 'Цветной рейтинг в списках', null, true);
        add('full_color', 'trigger', 'Цветные рейтинги внутри карточки', null, true);
        add('scale', 'select', 'Цветовая шкала', {detailed: 'Подробная - четыре цвета', simple: 'Простая - три цвета'}, 'detailed');
        Lampa.SettingsApi.addParam({component: 'wf_ratings', param: {name: 'wf_ratings_clear', type: 'button'},
            field: {name: 'Очистить кэш', description: 'Оценки из источника Lampa сохраняются на сутки и загружаются для постеров в фоне.'},
            onChange: function () {
                cache = {};
                generation++;
                queue = [];
                pending = {};
                retryUntil = {};
                clearTimeout(saveTimer);
                Lampa.Storage.set(CACHE, cache);
                refresh();
                Lampa.Noty.show('Кэш рейтингов очищен');
            }});
    }
    function init() {
        if (started || !window.Lampa || !document.body) return;
        started = true;
        try { cache = Lampa.Storage.get(CACHE, {}) || {}; } catch (e) { cache = {}; }
        if (typeof cache !== 'object' || Array.isArray(cache)) cache = {};
        // Deliberately ignore all caches from versions that used external APIs.
        Object.keys(cache).forEach(function (id) {
            if (!cache[id] || typeof cache[id] !== 'object') { delete cache[id]; return; }
            names.forEach(function (source) {
                var entry = cache[id][source];
                if (entry && (!isFinite(entry.time) || Date.now() - entry.time >= DAY || !isFinite(entry.value) || entry.value < 0 || entry.value > 10)) delete cache[id][source];
            });
        });
        var style = document.createElement('style');
        style.id = 'wf-ratings-style';
        style.textContent = '.card.wf-ratings-owned .card__vote{display:none!important}' +
            '.wf-ratings-vote{position:absolute;right:.3em;bottom:.3em;background:rgba(0,0,0,.5);color:#fff;font-size:1.3em;font-weight:700;padding:.2em .5em;border-radius:1em;z-index:1;pointer-events:none}' +
            '.wf-ratings-vote.hide{display:none!important}';
        document.head.appendChild(style);
        settings();
        Lampa.Listener.follow('full', onFull);
        if (window.IntersectionObserver) intersection = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) { if (entry.isIntersecting) preload(entry.target); });
        }, {rootMargin: '250px'});
        var observer = new MutationObserver(function (mutations) {
            var removed = false;
            mutations.forEach(function (m) {
                if (m.removedNodes.length) removed = true;
                // Native poster fields may be updated in place by Lampa.
                if (m.target.nodeType === 1 && m.target.matches('.card__vote')) {
                    var parent = m.target.closest ? m.target.closest('.card') : null;
                    if (parent) bindCard(parent);
                }
                for (var i = 0; i < m.addedNodes.length; i++) discover(m.addedNodes[i]);
            });
            if (removed) { clearTimeout(cleanTimer); cleanTimer = setTimeout(clean, 500); }
        });
        observer.observe(document.body, {childList: true, subtree: true});
        discover(document.body);
        if (!intersection) {
            var scanTimer;
            var scan = function () { clearTimeout(scanTimer); scanTimer = setTimeout(function () { clean(); cards.forEach(preload); }, 180); };
            document.addEventListener('scroll', scan, true);
            document.addEventListener('transitionend', scan, true);
            window.addEventListener('resize', scan);
        }
        try {
            var active = Lampa.Activity.active();
            if (active && active.activity && (active.movie || active.card)) onFull({type: 'complite', object: active, data: {movie: active.movie || active.card}});
        } catch (e) { /* No active activity yet. */ }
    }
    function ready() {
        if (!window.Lampa) return;
        if (window.appready) init();
        else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
})();
