// Proxy-feed для B24U — aquafloor-online.
// Читает полный YML клиента (230 товаров), отбирает 100 «премиальных» и публикует чистый фид.
//
// Критерий выборки (согласован с владельцем 2026-06-24):
//   - категория = коллекция (Classic/Nano/Stone/Space/Realwood/Parquet/Soundless/Aquawall…);
//   - берём товары ВЫШЕ средней цены своей коллекции там, где цена варьируется
//     (Parquet/Realwood/Realwood XL), иначе топ по цене внутри коллекции;
//   - квота пропорциональна размеру коллекции, минимум 2 на коллекцию, ровно 100 всего.
//
// Политика цены: money→менеджер. <price> в выходной фид НЕ кладём (B24U вшивает price в
// контекст модели → бот начал бы называть числа). Карточки рендерятся по
// currencyId/vendor/picture/url. Описание — чистое (исходный маркетинговый текст роняет
// релевантность RAG). Подробности — references/04-feeds-and-widgets.md, CHANGELOG клиента.

import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFileSync, mkdirSync } from 'node:fs';

const SOURCE_FEED_URL = process.env.SOURCE_FEED_URL
  || 'https://aquafloor-online.ru/wp-content/uploads/feed-yml-0.xml';
const OUT_PATH = 'public/feed.xml';
const TARGET = 100;

const CATNAME = { '136': 'Aquafloor', '215': 'Стеновые панели Aquawall', '357': 'Сопутствующие товары' };

function collectionOf(name, cat) {
  let s = String(name).replace(/^.*?Aquafloor\s*/i, '').trim();
  let eng = s.includes('/') ? s.split('/').slice(1).join('/') : s;
  eng = eng.split(/\s*AF\s*\d/i)[0].trim().replace(/\s+(Glue|Click|клеев\w*)$/i, '').trim();
  if (!eng || eng.length < 2 || /виниловый|ламинат|панель|подложк/i.test(eng)) {
    return cat === '136' ? 'Aquafloor (проч.)' : (CATNAME[cat] || 'ДРУГОЕ');
  }
  return eng;
}
function articleOf(name) {
  const m = String(name).match(/A[FW]\s*\d[\dA-Za-z]*(?:\s+[A-Za-z]{2,})?\s*$/);
  return m ? m[0].trim() : '';
}
function description(coll, art, cat) {
  const a = art ? ` Артикул ${art}.` : '';
  if (cat === '215') {
    return `Стеновые панели Aquawall. Влагостойкие декоративные стеновые панели Aquafloor.${a} Точную цену и расчёт количества подскажет менеджер.`;
  }
  return `Коллекция ${coll} (Aquafloor). Водостойкое напольное покрытие — кварц-винил/SPC.${a} Подбор декора, точную цену и расчёт количества подскажет менеджер.`;
}

const res = await fetch(SOURCE_FEED_URL, { headers: { 'User-Agent': 'b24u-feed-builder/1.0' } });
if (!res.ok) throw new Error(`Source feed fetch failed: ${res.status}`);
const xml = await res.text();

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true, isArray: (n) => n === 'offer' || n === 'category' });
const feed = parser.parse(xml);
const offers = feed?.yml_catalog?.shop?.offers?.offer ?? [];
if (!offers.length) throw new Error('No offers parsed from source feed');

const rows = offers.map(o => ({
  id: o['@_id'],
  name: String(o['name'] ?? '').trim(),
  price: parseInt(String(o['price'] ?? '0').replace(/[^\d]/g, ''), 10) || 0,
  cat: String(o['categoryId'] ?? '').trim(),
  url: String(o['url'] ?? '').trim(),
  pic: String(o['picture'] ?? '').trim(),
})).filter(r => r.id && r.name && r.url);
rows.forEach(r => { r.coll = collectionOf(r.name, r.cat); r.art = articleOf(r.name); });

// Группировка по коллекции, исключая «Сопутствующие товары» (1 подложка — не премиум-категория).
const byColl = {};
rows.forEach(r => { (byColl[r.coll] = byColl[r.coll] || []).push(r); });
const cats = Object.entries(byColl).filter(([c]) => c !== 'Сопутствующие товары');
const totalN = cats.reduce((s, [, a]) => s + a.length, 0);

let quota = cats.map(([c, a]) => ({ c, a, q: Math.max(2, Math.round(TARGET * a.length / totalN)) }));
let sum = quota.reduce((s, x) => s + x.q, 0);
while (sum > TARGET) { quota.sort((x, y) => y.q - x.q); for (const x of quota) { if (sum <= TARGET) break; if (x.q > 2) { x.q--; sum--; } } }
while (sum < TARGET) { quota.sort((x, y) => (y.a.length - y.q) - (x.a.length - x.q)); for (const x of quota) { if (sum >= TARGET) break; if (x.q < x.a.length) { x.q++; sum++; } } }

const selected = [];
quota.forEach(({ a, q }) => {
  const sorted = [...a].sort((x, y) => y.price - x.price || (+x.id) - (+y.id));
  selected.push(...sorted.slice(0, q));
});
if (selected.length !== TARGET) throw new Error(`Selected ${selected.length}, expected ${TARGET}`);

// Сборка выходного фида (без <price>).
const usedCats = [...new Set(selected.map(r => r.cat))];
const out = {
  '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
  yml_catalog: {
    '@_date': new Date().toISOString().slice(0, 16).replace('T', ' '),
    shop: {
      name: 'aquafloor-online', company: 'aquafloor-online', url: 'https://aquafloor-online.ru/',
      currencies: { currency: { '@_id': 'RUR', '@_rate': '1' } },
      categories: { category: usedCats.map(id => ({ '@_id': id, '#text': CATNAME[id] || id })) },
      offers: {
        offer: selected.map(r => {
          const o = {
            '@_id': r.id, '@_available': 'true',
            name: r.name,
            description: description(r.coll, r.art, r.cat),
            vendor: 'Aquafloor',
          };
          if (r.pic) o.picture = r.pic;
          o.url = r.url;
          o.currencyId = 'RUR';
          o.categoryId = r.cat;
          return o;
        }),
      },
    },
  },
};

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressBooleanAttributes: false, cdataPropName: '__cdata' });
// CDATA для description
out.yml_catalog.shop.offers.offer.forEach(o => { o.description = { __cdata: o.description }; });

mkdirSync('public', { recursive: true });
writeFileSync(OUT_PATH, builder.build(out), 'utf-8');

const byc = {}; selected.forEach(r => byc[r.coll] = (byc[r.coll] || 0) + 1);
console.log(`Done. Offers: ${selected.length}, categories: ${Object.keys(byc).length}, min/cat: ${Math.min(...Object.values(byc))}. Written to ${OUT_PATH}`);
