// Diyanet hutbe listesini e-Devlet sayfasından okuyup hutbe/hutbeler.json dosyasını günceller.
// GitHub Actions içinde çalışır (Node 20+, poppler-utils / pdftotext gerekir).
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

const DATA_PATH = process.env.DATA_PATH || 'hutbe/hutbeler.json';
const BASE = 'https://turkiye.gov.tr/diyanet-isleri-cuma-ve-bayram-hutbeleri';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; AyetinVaktiBot/1.0; +https://ayetinvakti.github.io/)' };

export function decodeEntities(s) {
    return String(s)
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}
const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// e-Devlet tablosundan { id, baslik, siraNo, ses } satırları çıkarır
export function parseList(html) {
    const rows = html.split(/<tr[\s>]/i).slice(1);
    const out = [];
    for (const row of rows) {
        const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
        if (tds.length < 2) continue;
        const d = /(\d{2})\.(\d{2})\.(\d{4})/.exec(stripTags(tds[0]));
        if (!d) continue;
        const sira = /siraNo=(\d+)/.exec(row);
        const sesHref = tds[4] ? /href="([^"]+)"/i.exec(tds[4]) : null;
        out.push({
            id: `${d[3]}-${d[2]}-${d[1]}`,
            baslik: stripTags(tds[1]),
            siraNo: sira ? Number(sira[1]) : null,
            ses: sesHref ? decodeEntities(sesHref[1]).replace(/^http:\/\//i, 'https://') : null
        });
    }
    return out;
}

const TEXT_VERSION = 3; // Ayrıştırma yöntemi değişince artır: eski metinler yeniden çekilir
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HEADING = /^[A-ZÇĞİÖŞÜÂÎÛ][^.?;:,“”"]{2,48}!$/;

// ---- Arapça yardımcıları ----
const AR_HARAKE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;   // ünlü/okunuş işaretleri
const arHarfler = (s) => s.replace(/[^\p{L}]/gu, '');
const arOrani = (s) => {
    const h = arHarfler(s);
    if (!h.length) return 0;
    return (h.match(new RegExp(ARABIC.source, 'g')) || []).length / h.length;
};
const arapcaSatir = (l) => arOrani(l) > 0.6;

// Arapça satırların PDF'ten hangi sırayla çıktığını istatistikle anlar (metin üretmez, yalnızca sıra denetler).
// Doğru (mantıksal) sırada kelimeler çoğunlukla "ال" ile başlar; ters (görsel) sırada "لا" ile biter.
// Dönüş: 'duzgun' | 'ters' | 'belirsiz'
export function arapcaSirasi(satirlar) {
    let basla = 0, biter = 0;
    for (const l of satirlar) {
        const kelimeler = l.normalize('NFKC').replace(AR_HARAKE, '').split(/\s+/);
        for (const k of kelimeler) {
            const t = k.replace(/[^\u0621-\u064A]/g, '');
            if (t.length < 3) continue;
            if (t.startsWith('ال')) basla++;
            if (t.endsWith('لا')) biter++;
        }
    }
    if (basla + biter < 3) return 'belirsiz';
    if (basla >= biter * 2) return 'duzgun';
    if (biter >= basla * 2) return 'ters';
    return 'belirsiz';
}
const satiriTersCevir = (l) => Array.from(l).reverse().join('');

// pdftotext -raw çıktısından gövde paragrafları, dipnot kaynakları ve Arapça var/yok bilgisini çıkarır.
// Arapça satırlar PDF'te yazıldığı gibi, kendi paragrafı olarak korunur; sırası güvenilir değilse yayına alınmaz.
export function extractBody(text, baslik) {
    const norm = (s) => s.toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
    let lines = text.replace(/\r/g, '').replace(/\f/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
    lines = lines.filter(l => !/^[.:;,!?\-–—]+$/.test(l));

    // Arapça satırları belirle ve sıralarını denetle
    let arapca = lines.some(l => ARABIC.test(l));
    const arSatirlar = lines.filter(arapcaSatir);
    let arModu = 'yok';
    if (arSatirlar.length) {
        const sira = arapcaSirasi(arSatirlar);
        const sadeceSembol = arSatirlar.every(l => arHarfler(l).length <= 1);   // tek karakterlik semboller (örn. besmele ligatürü)
        if (sira === 'duzgun' || sadeceSembol) arModu = 'duzgun';
        else if (sira === 'ters') arModu = 'ters';
        else arModu = 'guvenilmez';
        if (arModu === 'guvenilmez') console.warn(`Arapça satırların sırası doğrulanamadı (${baslik}); Arapça yayına alınmadı.`);
    }

    // Arapça-Türkçe karışık satırlar Türkçe metin olarak korunur; yalnızca baskın Arapça satırlar ayrı blok olur
    const items = [];
    for (const l of lines) {
        if (arapcaSatir(l)) {
            if (arModu === 'guvenilmez' || arModu === 'yok') continue;
            items.push({ ar: true, t: arModu === 'ters' ? satiriTersCevir(l) : l });
        } else {
            items.push({ ar: false, t: l });
        }
    }
    lines = items.filter(i => i.ar || (!/^Tarih:\s*\d/.test(i.t) && !/^Din Hizmetleri Genel Müdürlüğü$/.test(i.t)));

    // Sondaki dipnotlar: tek başına rakam satırı + kaynak satırı ("1" / "Tirmizî, Birr, 15.")
    const kaynaklar = [];
    const son = (n) => lines[lines.length - n];
    while (lines.length >= 2 && !son(1).ar && !son(2).ar && /^\d{1,2}$/.test(son(2).t) && son(1).t.length < 120) {
        kaynaklar.unshift(son(1).t);
        lines.length -= 2;
    }
    // "1 Tirmizî, Birr, 15." biçimi
    while (lines.length && !son(1).ar && /^\d{1,2}\s+\S.{2,100}$/.test(son(1).t) && /\d\.?$/.test(son(1).t) && son(1).t.length < 100) {
        kaynaklar.unshift(lines.pop().t.replace(/^\d{1,2}\s+/, ''));
    }

    // Satırları paragraflara topla; "Aziz Müminler!" gibi hitap satırları kendi başına paragraf olur;
    // ardışık Arapça satırlar tek Arapça paragraf olur.
    const paras = [];
    let cur = [];
    let arCur = [];
    const flush = () => { if (cur.length) { paras.push(cur.join(' ')); cur = []; } };
    const flushAr = () => { if (arCur.length) { paras.push(arCur.join(' ')); arCur = []; } };
    for (const it of lines) {
        if (it.ar) { flush(); arCur.push(it.t); continue; }
        flushAr();
        let l = it.t;
        // metin içine yapışmış dipnot numaralarını temizle: değildir.”1 Evet → değildir.” Evet
        l = l.replace(/([”"])(\d{1,2})(?=\s|$)/g, '$1').replace(/([.!?;,])(\d{1,2})(?=\s+[A-Za-zÇĞİÖŞÜÂÎÛçğıöşüâîû“])/g, '$1');
        if (HEADING.test(l) && norm(l) !== norm(baslik)) { flush(); paras.push(l); continue; }
        if (norm(l) === norm(baslik)) continue;
        cur.push(l);
    }
    flush(); flushAr();

    return { paragraflar: paras.map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean), kaynaklar, arapca };
}

async function fetchPdfText(siraNo, cookie, baslik) {
    const url = `${BASE}?hutbe=Indir&siraNo=${siraNo}&tur=pdf&sf=&download=1`;
    const res = await fetch(url, { headers: { ...HEADERS, Cookie: cookie, Referer: BASE } });
    if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('PDF değil (oturum/engel olabilir)');
    const tmp = path.join(tmpdir(), `hutbe-${siraNo}-${Date.now()}.pdf`);
    await writeFile(tmp, buf);
    try {
        const { stdout } = await run('pdftotext', ['-raw', '-enc', 'UTF-8', tmp, '-']);
        const body = extractBody(stdout, baslik);
        if (body.paragraflar.join(' ').length < 200) throw new Error('Metin çok kısa çıktı');
        return body;
    } finally {
        await unlink(tmp).catch(() => {});
    }
}

async function main() {
    let data = { guncelleme: null, kaynak: BASE, hutbeler: [] };
    try { data = JSON.parse(await readFile(DATA_PATH, 'utf8')); } catch { /* ilk çalıştırma */ }
    const before = JSON.stringify(data.hutbeler);

    const res = await fetch(BASE, { headers: HEADERS });
    if (!res.ok) throw new Error(`Liste sayfası HTTP ${res.status}`);
    const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    const rows = parseList(await res.text());
    if (rows.length === 0) throw new Error('Listede hutbe bulunamadı; sayfa yapısı değişmiş olabilir.');

    const map = new Map(data.hutbeler.map(h => [h.id, h]));
    for (const r of rows) {
        const h = map.get(r.id) || { id: r.id, tarih: r.id };
        h.baslik = r.baslik;
        if (r.ses) h.ses = r.ses;
        const eksik = !(h.metin && h.metin.length) || h.metinSurum !== TEXT_VERSION;
        if (eksik && r.siraNo !== null) {
            try {
                const body = await fetchPdfText(r.siraNo, cookie, r.baslik);
                h.metin = body.paragraflar;
                h.kaynaklar = body.kaynaklar;
                h.arapca = body.arapca;
                h.metinSurum = TEXT_VERSION;
                console.log(`Metin alındı: ${r.id} ${r.baslik}`);
            } catch (e) {
                console.warn(`Metin alınamadı (${r.id} ${r.baslik}): ${e.message}`);
            }
        }
        map.set(r.id, h);
    }

    data.hutbeler = [...map.values()].sort((a, b) => b.id.localeCompare(a.id));
    data.kaynak = BASE;
    if (JSON.stringify(data.hutbeler) === before) {
        console.log('Değişiklik yok.');
        return;
    }
    data.guncelleme = new Date().toISOString();
    await mkdir(path.dirname(DATA_PATH), { recursive: true });
    await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`Güncellendi: ${data.hutbeler.length} hutbe.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => { console.error(e); process.exit(1); });
}
