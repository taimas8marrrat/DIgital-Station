# Спецификация данных

Все данные — mock. Реальные только справочные: код ЕСР 708009, координаты, направления, расстояния до Саяка (189 км) и Достыка (318 км).

## station.json
Пути (`id, kind: passenger|main|freight, length, platform`), горловины (`west`, `east`), направления
(`south` Алматы, `west` Саяк — Мойынты, `north` Аягоз — Семей, `east` Достык), стрелки (`W1–W3`, `E1–E3` и пути, которые они обслуживают),
`route_headway_min` — интервал между движениями в горловине, `clear_min` — время освобождения пути.

## resources.json
`inspectors` — бригады осмотрщиков ПТО, `locos` — локомотивы под смену, `crews` — локомотивные бригады. Поле `capacity`.

## timetable.json
Генерируется `data/generate_timetable.py` (seed 42): 10 пассажирских + 37 грузовых/контейнерных в сутки.
Поля: `id, number, kind, from, to, length, arr, dep` (минуты от начала суток), `ops: {stop, inspection, loco_change, crew_change}`.

## Поток событий (WebSocket `/ws/ingest`, JSON-объект или массив)
| type | Поля | Смысл |
|---|---|---|
| clock | ts, speed_factor | Сим-время |
| position | train, km, speed | Поезд на подходе, км до входного сигнала |
| at_signal | train | Поезд у входного сигнала |
| delay | train, minutes | Опоздание |
| track_closed / track_opened | track, minutes | Закрытие/открытие пути |
| switch_failure / switch_repaired | switch, minutes | Отказ/исправление стрелки |
| wagon_defect | train, minutes | Неисправный вагон (+время стоянки) |
| resource | resource, delta | Изменение числа ресурсов |

Обязательные поля каждого события: `id` (для дедупликации), `ts` (сим-секунды UNIX), `type`.
Пример: `{"id":"a1b2","ts":1790832870,"type":"delay","train":"F2014-1001","minutes":25}`.
