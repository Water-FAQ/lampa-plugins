/* Ratings for Lampa - test version, 2026-10-26.
 * IMDb/KP lookup adapted from https://nb557.github.io/plugins/rating.js.
 * No account access, personal votes or additional scripts are used.
 */
(function () {
    'use strict';
    if (window.waterfaq_ratings) return;
    window.waterfaq_ratings = {version: '0.1.1'};

    var DAY = 86400000;
    // v1 contained independent CUB/TMDB entries and long-lived negative matches.
    var CACHE = 'wf_ratings_cache_v2';
    var cache = {};
    var records = {};
    var pending = {};
    var queue = [];
    var running = 0;
    var generation = 0;
    var pausedUntil = 0;
    var pumpTimer, saveTimer, scanTimer;
    var intersection, discovery;
    var initialized = false;
    var fullViews = [];
    var cards = [];
    var API = 'https://kinopoiskapiunofficial.tech/api/';

    // The public API credential used by the upstream plugin; not a user token.
    function apiKey() {
        var input = [85,4,115,118,107,125,10,70,85,67,82,14,32,110,102,43,9,19,85,73,4,83,33,110,52,44,92,21,72,22,87,1,118,32,100,127];
        var str = '123456789_KP3password', hash = 0, secret = '', i, j, x;
        for (i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        for (i = 0, j = 29; j >= 0; i += 3, j -= 3) {
            x = (((hash >>> i) & 7) << 3) + ((hash >>> j) & 7);
            secret += String.fromCharCode(x < 26 ? 97 + x : x < 52 ? 39 + x : x - 4);
        }
        str = '';
        for (i = 0; i < input.length; i++) str += String.fromCharCode(input[i] ^ secret.charCodeAt(i % secret.length));
        return str;
    }

    function setting(name, fallback) {
        return Lampa.Storage.get('wf_ratings_' + name, fallback);
    }
    function rating(value) {
        if (typeof value !== 'number' && typeof value !== 'string') return 0;
        var str = String(value).trim().replace(',', '.');
        if (!/^\d+(\.\d+)?$/.test(str)) return 0;
        var n = Number(str);
        return isFinite(n) && n > 0 && n <= 10 ? n : 0;
    }
    function format(n) { return n === 10 ? '10' : n.toFixed(1); }
    function color(n) {
        if (!n) return '';
        if (setting('scale', 'detailed') === 'simple') return n < 5 ? '#E57373' : n < 7 ? '#999999' : '#81C784';
        return n < 5 ? '#E57373' : n < 7 ? '#FFB74D' : n < 8 ? '#64B5F6' : '#81C784';
    }
    function paint(node, value, enabled) {
        if (!node) return;
        var desired = enabled && value ? color(value) : '';
        if (desired) {
            if (!node._wfRatingStyle) node._wfRatingStyle = [node.style.getPropertyValue('color'), node.style.getPropertyPriority('color')];
            if (node._wfRatingColor !== desired || node.style.getPropertyValue('color') !== node._wfRatingApplied || node.style.getPropertyPriority('color') !== 'important') node.style.setProperty('color', desired, 'important');
            node._wfRatingColor = desired;
            node._wfRatingApplied = node.style.getPropertyValue('color');
        } else if (node._wfRatingStyle) {
            node.style.removeProperty('color');
            if (node._wfRatingStyle[0]) node.style.setProperty('color', node._wfRatingStyle[0], node._wfRatingStyle[1]);
            delete node._wfRatingStyle;
            delete node._wfRatingColor;
            delete node._wfRatingApplied;
        }
    }
    function connected(node) { return !!node && document.documentElement.contains(node); }
    function movieType(data) {
        if (data.media_type === 'movie' || data.media_type === 'tv') return data.media_type;
        if (data.first_air_date) return 'tv';
        if (data.release_date) return 'movie';
        return data.original_name || (data.name && !data.title) ? 'tv' : 'movie';
    }
    function key(data) {
        var source = String(data.source || 'tmdb');
        // Lampa's CUB source uses TMDB IDs for films and TV series.
        if (source === 'cub') source = 'tmdb';
        return source + ':' + movieType(data) + ':' + String(data.id || '');
    }
    function known(data) {
        return {imdb: rating(data.imdb_rating || data.ratingImdb), kp: rating(data.kp_rating || data.ratingKinopoisk)};
    }
    function selected(data, result) {
        var values = known(data);
        if (result) {
            values.imdb = rating(result.imdb) || values.imdb;
            values.kp = rating(result.kp) || values.kp;
        }
        values.tmdb = rating(result && result.tmdb) || rating(data.vote_average);
        var priority = setting('priority', 'imdb');
        var order = priority === 'kp' ? ['kp', 'imdb', 'tmdb'] : priority === 'tmdb' ? ['tmdb', 'imdb', 'kp'] : ['imdb', 'kp', 'tmdb'];
        for (var i = 0; i < order.length; i++) if (values[order[i]]) return values[order[i]];
        return 0;
    }
    function imdbId(data) { return data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || ''; }
    function kpId(data) { return data.kinopoisk_id || data.kinopoiskId || ''; }
    function fingerprint(data) {
        return [imdbId(data), kpId(data), year(data), normalize(data.original_title || data.original_name), normalize(data.title || data.name)].join('|');
    }
    function strength(data) { return imdbId(data) || kpId(data) ? 3 : year(data) ? 2 : 1; }
    function copy(data) {
        var result = {};
        ['id', 'source', 'media_type', 'title', 'name', 'original_title', 'original_name', 'release_date', 'first_air_date', 'year', 'vote_average', 'imdb_rating', 'kp_rating', 'ratingImdb', 'ratingKinopoisk'].forEach(function (field) {
            if (data[field] !== undefined && data[field] !== null && data[field] !== '') result[field] = data[field];
        });
        result.imdb_id = imdbId(data);
        result.kinopoisk_id = kpId(data);
        return result;
    }
    function remember(data, full) {
        var id = key(data), entry = records[id] || {data: {}, full: false};
        var incoming = copy(data);
        Object.keys(incoming).forEach(function (field) {
            if (incoming[field] !== '' && (full || !entry.full || entry.data[field] === undefined || entry.data[field] === '')) entry.data[field] = incoming[field];
        });
        if (full) entry.full = true;
        records[id] = entry;
        var scores = known(data);
        if (full || scores.imdb || scores.kp) {
            var stored = cache[id] || {imdb: 0, kp: 0, time: 0};
            if (full && ((imdbId(data) && stored.matchedImdb && imdbId(data) !== stored.matchedImdb) || (kpId(data) && stored.matchedKp && String(kpId(data)) !== stored.matchedKp))) {
                stored = {imdb: 0, kp: 0, time: 0};
            }
            // Full-card metadata can fill gaps, without replacing a fresh API score.
            stored.imdb = rating(stored.imdb) || scores.imdb;
            stored.kp = rating(stored.kp) || scores.kp;
            if (full && rating(data.vote_average)) stored.tmdb = rating(data.vote_average);
            cache[id] = stored;
            save();
            broadcast(id);
        }
        return copy(entry.data);
    }
    function broadcast(id) {
        cards.forEach(function (node) {
            var data = connected(node) && getData(node);
            if (data && key(data) === id) drawCard(node, cache[id]);
        });
        fullViews.forEach(function (view) { if (connected(view.root) && key(view.data) === id) showFull(view, cache[id]); });
    }
    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            var keys = Object.keys(cache).sort(function (a, b) { return cache[b].time - cache[a].time; });
            for (var i = 1000; i < keys.length; i++) delete cache[keys[i]];
            try { Lampa.Storage.set(CACHE, cache); } catch (e) { /* Storage full: keep the session cache. */ }
        }, 400);
    }
    function request(url, xml, done) {
        var network = new Lampa.Reguest(), completed = false;
        var watchdog = setTimeout(function () { finish(null, {status: 0}); network.clear(); }, 17000);
        function finish(data, error) {
            if (completed) return;
            completed = true;
            clearTimeout(watchdog);
            done(data, error);
        }
        network.timeout(xml ? 5000 : 12000);
        try {
            network[xml ? 'native' : 'silent'](url, function (data) { finish(data, null); }, function (error) {
                finish(null, error || {status: 0});
            }, false, xml ? {dataType: 'text'} : {headers: {'X-API-KEY': apiKey()}});
        } catch (e) { finish(null, {status: 0}); }
    }
    function normalize(str) {
        return String(str || '').toLowerCase().replace(/ё/g, 'е').replace(/[\u2010-\u2015]/g, '-')
            .replace(/[^a-zа-я0-9\u00c0-\uffff]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function year(data) { return parseInt(String(data.first_air_date || data.release_date || data.year || '').slice(0, 4), 10) || 0; }
    function choose(items, data) {
        var imdb = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
        if (imdb) {
            var exact = items.filter(function (item) { return (item.imdbId || item.imdb_id) === imdb; });
            if (exact.length === 1) return exact[0];
            if (exact.length > 1) return null;
        }
        var titles = [data.original_title, data.original_name, data.title, data.name].map(normalize).filter(Boolean);
        var targetYear = year(data), type = movieType(data);
        var matches = items.filter(function (item) {
            if (imdb && (item.imdbId || item.imdb_id) && (item.imdbId || item.imdb_id) !== imdb) return false;
            var itemType = String(item.type || '').toUpperCase();
            if (itemType && itemType !== 'UNKNOWN') {
                if (type === 'movie' && itemType !== 'FILM') return false;
                if (type === 'tv' && itemType === 'FILM') return false;
            }
            var itemYear = parseInt(String(item.year || '').slice(0, 4), 10);
            if (!targetYear || !itemYear || Math.abs(targetYear - itemYear) > 1) return false;
            return [item.nameOriginal, item.nameEn, item.nameRu].some(function (name) {
                var n = normalize(name);
                return n && titles.indexOf(n) !== -1;
            });
        });
        var sameYear = matches.filter(function (item) { return parseInt(item.year, 10) === targetYear; });
        if (sameYear.length) matches = sameYear;
        return matches.length === 1 ? matches[0] : null;
    }
    function lookup(data, done) {
        function details(item) {
            function found(result) {
                result.matchedImdb = item.imdbId || item.imdb_id || imdbId(data);
                result.matchedKp = String(item.kinopoiskId || item.filmId || item.kinopoisk_id || '');
                done(result);
            }
            // v2.2 search responses usually contain both ratings already.
            if (Object.prototype.hasOwnProperty.call(item, 'ratingImdb') && Object.prototype.hasOwnProperty.call(item, 'ratingKinopoisk')) {
                found({imdb: rating(item.ratingImdb), kp: rating(item.ratingKinopoisk)});
                return;
            }
            var kp = item.kinopoiskId || item.filmId || item.kinopoisk_id;
            if (!/^\d+$/.test(String(kp || ''))) { done({imdb: 0, kp: 0}); return; }
            request('https://rating.kinopoisk.ru/' + kp + '.xml', true, function (xml) {
                if (typeof xml === 'string') {
                    try {
                        var doc = new DOMParser().parseFromString(xml, 'text/xml');
                        if (doc.querySelector('rating') && !doc.querySelector('parsererror')) {
                            var im = doc.querySelector('imdb_rating'), kr = doc.querySelector('kp_rating');
                            var result = {imdb: rating(im && im.textContent), kp: rating(kr && kr.textContent)};
                            if (result.imdb || result.kp) { found(result); return; }
                        }
                    } catch (e) { /* Use the JSON API when XML is unavailable. */ }
                }
                request(API + 'v2.2/films/' + kp, false, function (film, error) {
                    if (error) done(null, error);
                    else if (!film || !film.kinopoiskId) done(null, {status: 0});
                    else {
                        if (film.imdbId) item.imdbId = film.imdbId;
                        found({imdb: rating(film.ratingImdb), kp: rating(film.ratingKinopoisk)});
                    }
                });
            });
        }
        function searchTitle(original) {
            var title = original ? data.original_title || data.original_name : data.title || data.name || data.original_title || data.original_name;
            if (!title) { done({imdb: 0, kp: 0}); return; }
            var url = API + 'v2.2/films?keyword=' + encodeURIComponent(title);
            var y = year(data);
            if (y) url += '&yearFrom=' + (y - 1) + '&yearTo=' + (y + 1);
            if (movieType(data) === 'movie') url += '&type=FILM';
            request(url, false, function (json, error) {
                if (error) { done(null, error); return; }
                if (!json || (!Array.isArray(json.films) && !Array.isArray(json.items))) { done(null, {status: 0}); return; }
                var match = choose(json.films || json.items, data);
                if (match) details(match);
                else if (!original && normalize(data.original_title || data.original_name) && normalize(data.original_title || data.original_name) !== normalize(title)) searchTitle(true);
                else done({imdb: 0, kp: 0});
            });
        }
        var kp = data.kinopoisk_id || data.kinopoiskId;
        if (/^\d+$/.test(String(kp || ''))) { details({kinopoiskId: kp}); return; }
        var imdb = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
        if (!/^tt\d+$/.test(String(imdb || ''))) { searchTitle(); return; }
        request(API + 'v2.2/films?imdbId=' + encodeURIComponent(imdb), false, function (json, error) {
            if (error) { done(null, error); return; }
            if (!json || !Array.isArray(json.items)) { done(null, {status: 0}); return; }
            var match = choose(json.items, data);
            if (match) details(match);
            else searchTitle();
        });
    }
    function pump() {
        clearTimeout(pumpTimer);
        if (pausedUntil > Date.now()) { pumpTimer = setTimeout(pump, Math.min(pausedUntil - Date.now(), 60000)); return; }
        while (running < 2 && queue.length) {
            var job = queue.shift();
            if (!job.subscribers.some(function (s) { return s.alive(); })) { delete pending[job.key]; continue; }
            execute(job);
        }
    }
    function execute(job) {
        running++;
        job.started = true;
        lookup(job.data, function (result, error) {
            running--;
            if (pending[job.key] === job) delete pending[job.key];
            if (job.generation === generation) {
                // Do not let an older title-only response overwrite a later exact ID.
                if (job.nextData) {
                    job.data = job.nextData;
                    job.fingerprint = fingerprint(job.data);
                    delete job.nextData;
                    job.started = false;
                    pending[job.key] = job;
                    queue.unshift(job);
                    pumpTimer = setTimeout(pump, 80);
                    return;
                }
                if (error) {
                    var status = Number(error.status || error.statusCode || 0);
                    if (status === 401 || status === 403 || status === 402) pausedUntil = Date.now() + 15 * 60000;
                    else if (status === 429) pausedUntil = Date.now() + 60000;
                    var old = cache[job.key] || {imdb: 0, kp: 0, time: 0};
                    old.retry = Date.now() + 5 * 60000;
                    cache[job.key] = old;
                    result = old;
                } else {
                    var existing = cache[job.key] || {};
                    result.imdb = rating(result.imdb) || rating(existing.imdb);
                    result.kp = rating(result.kp) || rating(existing.kp);
                    result.tmdb = rating(existing.tmdb);
                    result.time = Date.now();
                    result.ttl = result.imdb || result.kp ? DAY : 15 * 60000;
                    result.fingerprint = job.fingerprint;
                    result.strength = strength(job.data);
                    result.lookupImdb = imdbId(job.data);
                    result.lookupKp = String(kpId(job.data));
                    cache[job.key] = result;
                }
                save();
                broadcast(job.key);
                job.subscribers.forEach(function (s) { if (s.alive()) s.done(result); });
            }
            pumpTimer = setTimeout(pump, 150);
        });
    }
    function fetchRatings(data, callback, alive, urgent) {
        data = remember(data, false);
        var id = key(data), stored = cache[id];
        var fp = fingerprint(data);
        if (stored) callback(stored);
        var improved = stored && (strength(data) > (stored.strength || 0) || (imdbId(data) && imdbId(data) !== stored.lookupImdb) || (kpId(data) && String(kpId(data)) !== stored.lookupKp) || (!stored.imdb && !stored.kp && fp !== stored.fingerprint));
        if (stored && (stored.retry > Date.now() || (!improved && Date.now() - stored.time < (stored.ttl || DAY)))) return;
        if (pending[id]) {
            if (!pending[id].subscribers.some(function (s) { return s.done === callback; })) pending[id].subscribers.push({done: callback, alive: alive});
            if (fp !== pending[id].fingerprint && (strength(data) > strength(pending[id].data) || (imdbId(data) && imdbId(data) !== imdbId(pending[id].data)) || (kpId(data) && kpId(data) !== kpId(pending[id].data)))) {
                if (pending[id].started) pending[id].nextData = copy(data);
                else { pending[id].data = copy(data); pending[id].fingerprint = fp; }
            }
            if (urgent) queue.sort(function (a, b) { return (b.key === id ? 1 : 0) - (a.key === id ? 1 : 0); });
            return;
        }
        var job = {key: id, data: copy(data), fingerprint: fp, generation: generation, subscribers: [{done: callback, alive: alive}]};
        pending[id] = job;
        if (urgent) queue.unshift(job);
        else queue.push(job);
        clearTimeout(pumpTimer);
        pumpTimer = setTimeout(pump, 80);
    }
    function getData(node) {
        // Custom Shikimori posters have their own score and ID namespace.
        if (node.classList.contains('LMEShikimori')) return null;
        var candidates = [node.card_data, node._card, node.card, node.data];
        for (var i = 0; i <= candidates.length; i++) {
            if (i === 4 && window.$) {
                try {
                    var jq = $(node);
                    candidates.push(jq.data('card_data'), jq.data('card'), jq.data('item'), jq.data('data'));
                } catch (e) { /* A custom wrapper need not provide jQuery data(). */ }
            }
            var data = candidates[i];
            if (!data || typeof data !== 'object') continue;
            if (data.data && !data.id) data = data.data;
            if (data.movie && !data.id) data = data.movie;
            if (!data || !data.id || !(data.title || data.name) || data.media_type === 'person' || data.known_for_department || data.source === 'shikimori') continue;
            return data;
        }
        return null;
    }
    function drawCard(node, result) {
        var data = getData(node), badge = node.querySelector('.wf-ratings-vote');
        if (!data) {
            // A recycled DOM card must not keep the previous film's owned badge.
            node.classList.remove('wf-ratings-owned');
            if (badge) badge.classList.add('hide');
            badge = node.querySelector('.card__vote');
            if (badge) paint(badge, rating(badge.textContent), setting('list_color', true));
            return;
        }
        // Never interpret a CUB popularity/fire counter as a ten-point score.
        // The owned badge always uses an actual rating, even on these cards.
        var n = selected(data, result || cache[key(data)]);
        if (n && !badge) {
            var view = node.querySelector('.card__view');
            if (!view) return;
            badge = document.createElement('div');
            // Keep our score separate from the native field used by other plugins.
            badge.className = 'wf-ratings-vote';
            view.appendChild(badge);
        }
        if (!badge) return;
        node.classList.add('wf-ratings-owned');
        if (n) {
            var text = format(n);
            if (badge.textContent !== text) badge.textContent = text;
            badge.classList.remove('hide');
        } else badge.classList.add('hide');
        paint(badge, n, setting('list_color', true));
    }
    function visible(node) {
        if (!connected(node)) return false;
        var r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > -200 && r.right > -200 && r.top < window.innerHeight + 200 && r.left < window.innerWidth + 200;
    }
    function updateCard(node) {
        if (!visible(node)) return;
        drawCard(node);
        var data = getData(node);
        if (!data || (setting('priority', 'imdb') === 'tmdb' && rating(data.vote_average))) return;
        var id = key(data);
        if (!node._wfRatingCallback || node._wfRatingKey !== id) {
            node._wfRatingKey = id;
            node._wfRatingCallback = function (result) {
                if (connected(node) && getData(node) && key(getData(node)) === id) drawCard(node, result);
            };
        }
        fetchRatings(data, node._wfRatingCallback, function () { return visible(node) && getData(node) && key(getData(node)) === id; }, false);
    }
    function bindCard(node) {
        if (!node._wfRatingBound) {
            node._wfRatingBound = true;
            node.addEventListener('visible', function () { updateCard(node); });
            node.addEventListener('hover:focus', function () { updateCard(node); });
            node.addEventListener('update', function () { updateCard(node); });
        }
        if (cards.indexOf(node) === -1) {
            cards.push(node);
            if (intersection) intersection.observe(node);
        }
        updateCard(node);
        if (!getData(node) && !node.classList.contains('LMEShikimori') && !node._wfRatingRetry) {
            node._wfRatingRetry = true;
            // Some custom card builders attach metadata after inserting the DOM.
            [100, 400, 1000].forEach(function (delay) {
                setTimeout(function () { if (connected(node) && !node.querySelector('.wf-ratings-vote')) updateCard(node); }, delay);
            });
        }
    }
    function fullColors(line) {
        var badges = line.querySelectorAll('.full-start__rate');
        for (var i = 0; i < badges.length; i++) {
            var value = badges[i].firstElementChild;
            if (!value) continue;
            var n = rating(value.textContent);
            paint(value, n, setting('full_color', true));
            if (n && badges[i]._wfRatingEmpty) {
                badges[i].classList.remove('hide');
                delete badges[i]._wfRatingEmpty;
            } else if (!n && !badges[i].classList.contains('hide')) {
                badges[i].classList.add('hide');
                badges[i]._wfRatingEmpty = true;
            }
        }
    }
    function bindLine(line) {
        if (!line._wfRatingObserver) {
            var timer;
            line._wfRatingObserver = new MutationObserver(function () {
                clearTimeout(timer);
                timer = setTimeout(function () { fullColors(line); }, 40);
            });
            line._wfRatingObserver.observe(line, {childList: true, subtree: true, characterData: true});
        }
        fullColors(line);
    }
    function showFull(view, result) {
        if (view.root._wfRatingView !== view) return;
        var line = view.root.querySelector('.full-start-new__rate-line, .full-start__rate-line');
        if (!line) return;
        bindLine(line);
        line.classList.add('wf-ratings-full-owned');
        var values = known(view.data);
        if (result) { values.imdb = rating(result.imdb) || values.imdb; values.kp = rating(result.kp) || values.kp; }
        values.tmdb = rating(result && result.tmdb) || rating(view.data.vote_average);
        ['tmdb', 'imdb', 'kp'].forEach(function (source) {
            var badge = line.querySelector('.wf-ratings-' + source);
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'full-start__rate wf-ratings-rate wf-ratings-' + source;
                badge.appendChild(document.createElement('div'));
                var label = document.createElement('div');
                label.textContent = source === 'tmdb' ? 'TMDB' : source === 'imdb' ? 'IMDb' : 'KP';
                badge.appendChild(label);
                var before = line.querySelector(source === 'tmdb' ? '.wf-ratings-imdb, .wf-ratings-kp, .rate--shikimori, .full-start__pg, .full-start__status' : source === 'imdb' ? '.wf-ratings-kp, .rate--shikimori, .full-start__pg, .full-start__status' : '.rate--shikimori, .full-start__pg, .full-start__status');
                line.insertBefore(badge, before);
            }
            if (!badge) return;
            if (values[source]) {
                var text = format(values[source]);
                if (badge.firstElementChild.textContent !== text) badge.firstElementChild.textContent = text;
                badge.classList.remove('hide');
                delete badge._wfRatingEmpty;
            } else {
                if (badge.firstElementChild.textContent !== '') badge.firstElementChild.textContent = '';
                badge.classList.add('hide');
            }
        });
        fullColors(line);
    }
    function onFull(e) {
        if (e.type !== 'complite' && e.type !== 'complete') return;
        var object = e.object || {};
        var activity = object.activity;
        var rendered = e.body || (activity && activity.render && activity.render());
        var root = rendered && (rendered[0] || rendered);
        var data = e.data && e.data.movie || object.movie || object.card;
        if (!root || !root.querySelector || !data) return;
        data = copy(data);
        if (object.method === 'tv' || object.method === 'movie') data.media_type = object.method;
        var view = {root: root, data: data};
        root._wfRatingView = view;
        fullViews = fullViews.filter(function (old) { return connected(old.root) && old.root !== root; });
        fullViews.push(view);
        remember(data, true);
        showFull(view, cache[key(data)]);
        fetchRatings(data, function (result) { showFull(view, result); }, function () { return connected(root) && root._wfRatingView === view; }, true);
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
        if (root.matches('.full-start-new__rate-line, .full-start__rate-line')) bindLine(root);
        found = root.querySelectorAll('.full-start-new__rate-line, .full-start__rate-line');
        for (i = 0; i < found.length; i++) bindLine(found[i]);
    }
    function clean() {
        cards = cards.filter(function (node) {
            if (connected(node)) return true;
            if (intersection) intersection.unobserve(node);
            return false;
        });
        fullViews = fullViews.filter(function (view) { return connected(view.root); });
    }
    function refresh() {
        clean();
        cards.forEach(function (node) { drawCard(node); updateCard(node); });
        fullViews.forEach(function (view) { showFull(view, cache[key(view.data)]); });
        var lines = document.querySelectorAll('.full-start-new__rate-line, .full-start__rate-line');
        for (var i = 0; i < lines.length; i++) fullColors(lines[i]);
    }
    function settings() {
        Lampa.SettingsApi.addComponent({component: 'wf_ratings', name: 'Рейтинг', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>'});
        function add(name, type, title, values, fallback) {
            Lampa.SettingsApi.addParam({
                component: 'wf_ratings',
                param: {name: 'wf_ratings_' + name, type: type, values: values, default: fallback},
                field: {name: title},
                onChange: function () { setTimeout(refresh, 0); }
            });
        }
        add('priority', 'select', 'Приоритет рейтинга', {imdb: 'IMDb', kp: 'Кинопоиск', tmdb: 'TMDB'}, 'imdb');
        add('list_color', 'trigger', 'Цветной рейтинг в списках', null, true);
        add('full_color', 'trigger', 'Цветные рейтинги внутри карточки', null, true);
        add('scale', 'select', 'Цветовая шкала', {detailed: 'Подробная - четыре цвета', simple: 'Простая - три цвета'}, 'detailed');
        Lampa.SettingsApi.addParam({component: 'wf_ratings', param: {name: 'wf_ratings_clear', type: 'button'},
            field: {name: 'Очистить кэш', description: 'Оценки сохраняются на сутки и обновляются в фоне.'},
            onChange: function () {
                generation++;
                cache = {};
                records = {};
                queue.forEach(function (job) { delete pending[job.key]; });
                queue = [];
                pending = {};
                pausedUntil = 0;
                clearTimeout(saveTimer);
                Lampa.Storage.set(CACHE, cache);
                refresh();
                fullViews.forEach(function (view) {
                    remember(view.data, true);
                    fetchRatings(view.data, function (result) { showFull(view, result); }, function () { return connected(view.root) && view.root._wfRatingView === view; }, true);
                });
                Lampa.Noty.show('Кэш рейтингов очищен');
            }
        });
    }
    function init() {
        if (initialized || !window.Lampa || !document.body) return;
        initialized = true;
        try { cache = Lampa.Storage.get(CACHE, {}) || {}; } catch (e) { cache = {}; }
        if (typeof cache !== 'object' || Array.isArray(cache)) cache = {};
        Object.keys(cache).forEach(function (id) { if (!cache[id] || typeof cache[id] !== 'object') delete cache[id]; });
        var style = document.createElement('style');
        style.id = 'wf-ratings-style';
        style.textContent = '.card.wf-ratings-owned .card__vote{display:none!important}' +
            '.wf-ratings-vote{position:absolute;right:.3em;bottom:.3em;background:rgba(0,0,0,.5);color:#fff;font-size:1.3em;font-weight:700;padding:.2em .5em;border-radius:1em;z-index:1;pointer-events:none}' +
            '.wf-ratings-vote.hide{display:none!important}' +
            '.wf-ratings-full-owned .rate--tmdb,.wf-ratings-full-owned .rate--imdb,.wf-ratings-full-owned .rate--kp{display:none!important}';
        document.head.appendChild(style);
        settings();
        Lampa.Listener.follow('full', onFull);
        if (window.IntersectionObserver) {
            intersection = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) { if (entry.isIntersecting) updateCard(entry.target); });
            }, {rootMargin: '200px'});
        }
        discovery = new MutationObserver(function (mutations) {
            var removed = false;
            mutations.forEach(function (m) {
                if (m.removedNodes.length) removed = true;
                for (var i = 0; i < m.addedNodes.length; i++) discover(m.addedNodes[i]);
            });
            if (removed) {
                clearTimeout(scanTimer);
                scanTimer = setTimeout(clean, 500);
            }
        });
        discovery.observe(document.body, {childList: true, subtree: true});
        discover(document.body);
        // Fallback for engines without IntersectionObserver; debounce navigation/scroll.
        if (!intersection) {
            var timer;
            var scan = function () { clearTimeout(timer); timer = setTimeout(function () { clean(); cards.forEach(updateCard); }, 180); };
            document.addEventListener('scroll', scan, true);
            document.addEventListener('transitionend', scan, true);
            window.addEventListener('resize', scan);
        }
        // A full card may already be open when the plugin is enabled.
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
