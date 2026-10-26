/*
 * Lampa: Прежняя история просмотров
 * Version: 1.0.0
 * License: MIT
 *
 * Возвращает стандартный экран истории до обновления 3.4.0.
 * Работает через общий API Lampa, без зависимости от платформы.
 * Синхронизация CUB и сохранение истории остаются штатными.
 *
 * Установка: разместить этот файл по доступному HTTP(S)-адресу,
 * добавить адрес в Lampa: Настройки -> Расширения -> Добавить плагин.
 * Затем полностью перезапустить Lampa и открыть «Историю» заново.
 * Откат: отключить или удалить плагин и перезапустить Lampa.
 */
(function () {
    'use strict';

    function start() {
        var lampa = window.Lampa;
        if (!lampa || !lampa.Favorite) return;

        var favorite = lampa.Favorite;
        // В старых версиях выбор экрана уже работает по прежней схеме.
        if (typeof favorite.historyActivity !== 'function') return;
        if (favorite.historyActivity.legacyHistoryPlugin) return;

        function legacyHistoryActivity() {
            return {
                component: 'favorite',
                type: 'history',
                title: lampa.Lang.translate('title_history')
            };
        }

        // Меню и цветная кнопка пульта вызывают одну и ту же функцию.
        legacyHistoryActivity.legacyHistoryPlugin = true;
        favorite.historyActivity = legacyHistoryActivity;
    }

    if (window.appready) {
        start();
    } else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') start();
        });
    }
}());
