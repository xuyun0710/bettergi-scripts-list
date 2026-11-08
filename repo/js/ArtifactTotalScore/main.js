// ============================================================
// 原神 · 角色圣遗物总评分脚本（BetterGI JavaScript 脚本）
// 入口文件：main.js
// 配套：manifest.json / settings.json / characters.json / zones.json
// 编码：UTF-8
// ============================================================
(async function () {
    'use strict';

    //#region CORE —— 纯函数评分内核（不依赖 BGI，可被 tools/selftest.mjs 单独测试）

    // 基础单位分（提瓦特小助手口径）：
    // 1% 暴击率 = 2 分，1% 暴击伤害 = 1 分，1% 攻击/生命 = 1.333 分，
    // 1% 防御 = 1.067 分，1 点精通 = 0.333 分，1% 充能 = 1.205 分
    const UNIT = {
        '暴击率': 2.0,
        '暴击伤害': 1.0,
        '攻击力%': 1.3333,
        '生命值%': 1.3333,
        '防御力%': 1.0667,
        '元素精通': 0.3333,
        '元素充能效率': 1.2048
    };

    // 只会出现在主词条上的词条
    const MAIN_ONLY = ['元素伤害加成', '物理伤害加成', '治疗加成'];

    // 固定值词条 → 依赖的基准面板字段
    const FLAT_BASE = { '攻击力': 'baseAtk', '生命值': 'baseHp', '防御力': 'baseDef' };
    const FLAT_UNIT = { '攻击力': '攻击力%', '生命值': '生命值%', '防御力': '防御力%' };
    const BASE_DEFAULT = { baseAtk: 900, baseHp: 14000, baseDef: 700 };

    // 一个满词条 ≈ 6.6 分（3.3% 暴击率 × 2）
    const SCORE_PER_ROLL = 6.6;
    // 5 星圣遗物单件理论上限：4 条初始副词条 + 5 次强化 = 9 词条
    const MAX_ROLLS_PER_ARTIFACT = 9;
    const MAX_SCORE_PER_ARTIFACT = MAX_ROLLS_PER_ARTIFACT * SCORE_PER_ROLL; // 59.4

    const PATTERNS = [
        { key: '暴击伤害', re: /暴[击擊]伤害/ },
        { key: '暴击率', re: /暴[击擊]率/ },
        { key: '元素充能效率', re: /(元素)?充能效率/ },
        { key: '元素精通', re: /(元素)?精通/ },
        { key: '物理伤害加成', re: /物理伤害加成/ },
        { key: '治疗加成', re: /治疗加成/ },
        { key: '元素伤害加成', re: /元素伤害加成/ },
        { key: '攻击力', re: /攻击力/ },
        { key: '生命值', re: /生命值/ },
        { key: '防御力', re: /防御力/ }
    ];

    // 归一化 OCR 文本：全角转半角、去空格、统一百分号
    function normalize(raw) {
        if (raw === null || raw === undefined) return '';
        return String(raw)
            .replace(/％/g, '%')
            .replace(/＋/g, '+')
            .replace(/[０-９]/g, function (c) {
                return String.fromCharCode(c.charCodeAt(0) - 65248);
            })
            .replace(/[\s\u3000]/g, '')
            .replace(/[，,、]/g, '');
    }

    // 解析一行 OCR 文本 → { stat, value, percent }
    // 支持："暴击率+7.8%" "攻击力 45" "元素精通+23" "火元素伤害加成+46.6%"
    function parseStatLine(raw) {
        const text = normalize(raw);
        if (!text) return null;

        let best = null;
        for (let i = 0; i < PATTERNS.length; i++) {
            const p = PATTERNS[i];
            const m = text.match(p.re);
            if (m && m.index !== undefined && m.index >= 0) {
                if (!best || m.index < best.index) {
                    best = { key: p.key, index: m.index, len: m[0].length };
                }
            }
        }
        if (!best) return null;

        const rest = text.slice(best.index + best.len);
        const numMatch = rest.match(/(\d+(?:\.\d+)?)/);
        if (!numMatch) return null;

        const value = parseFloat(numMatch[1]);
        if (!isFinite(value) || value <= 0) return null;

        const percent = rest.indexOf('%') >= 0;
        let stat = best.key;
        if (best.key === '攻击力' || best.key === '生命值' || best.key === '防御力') {
            stat = percent ? best.key + '%' : best.key;
        }
        return { stat: stat, value: value, percent: percent };
    }

    // 把 OCR 结果按行解析成词条，并区分主词条 / 副词条
    function splitMainAndSub(lines, filter) {
        const f = filter || {};
        const th = {
            '生命值': f.hpFlat || 1500,
            '攻击力': f.atkFlat || 200,
            '防御力': f.defFlat || 150,
            '攻击力%': f.pct || 35,
            '生命值%': f.pct || 35,
            '防御力%': f.pct || 35,
            '元素精通': f.em || 150,
            '元素充能效率': f.er || 40
        };

        const subs = [];
        const mains = [];
        const seen = {};
        for (let i = 0; i < lines.length; i++) {
            const line = typeof lines[i] === 'string' ? lines[i] : lines[i].text;
            const parsed = parseStatLine(line);
            if (!parsed) continue;

            const isMainOnly = MAIN_ONLY.indexOf(parsed.stat) >= 0;
            const limit = th[parsed.stat];
            const isMain = isMainOnly || (limit !== undefined && parsed.value >= limit);
            if (isMain) {
                mains.push(parsed);
                continue;
            }

            // 同名词条去重（OCR 常把同一行识别两次）
            const key = parsed.stat + ':' + parsed.value.toFixed(1);
            if (seen[key]) continue;
            seen[key] = true;
            subs.push(parsed);
        }
        return { subs: subs, mains: mains };
    }

    function weightOf(stat, weights) {
        const w = weights || {};
        if (w[stat] !== undefined && w[stat] !== null) return Number(w[stat]);
        const alt = stat.charAt(stat.length - 1) === '%' ? stat.slice(0, -1) : stat + '%';
        if (w[alt] !== undefined && w[alt] !== null) return Number(w[alt]);
        return 1;
    }

    // 单件圣遗物评分
    function scoreArtifact(substats, profile, opts) {
        const p = profile || {};
        const weights = p.weights || {};
        const flatFactor = p.flatFactor !== undefined && p.flatFactor !== null ? Number(p.flatFactor) : 0.5;
        const base = {
            baseAtk: p.baseAtk || BASE_DEFAULT.baseAtk,
            baseHp: p.baseHp || BASE_DEFAULT.baseHp,
            baseDef: p.baseDef || BASE_DEFAULT.baseDef
        };

        const entries = [];
        let total = 0;
        let cr = 0;
        let cd = 0;

        for (let i = 0; i < substats.length; i++) {
            const s = substats[i];
            if (s.stat === '暴击率') cr += s.value;
            if (s.stat === '暴击伤害') cd += s.value;

            const w = weightOf(s.stat, weights);
            if (w === 0) {
                entries.push({ stat: s.stat, value: s.value, weight: 0, equiv: 0, score: 0 });
                continue;
            }

            let score = 0;
            let equiv = 0;
            if (FLAT_BASE[s.stat]) {
                // 固定值词条：按角色基准面板折算成等效百分比
                const b = base[FLAT_BASE[s.stat]] || BASE_DEFAULT[FLAT_BASE[s.stat]];
                equiv = (s.value / b) * 100;
                score = equiv * (UNIT[FLAT_UNIT[s.stat]] || 1) * w * flatFactor;
            } else {
                equiv = s.value;
                score = s.value * (UNIT[s.stat] || 0) * w;
            }

            total += score;
            entries.push({ stat: s.stat, value: s.value, weight: w, equiv: equiv, score: score });
        }

        const cv = cr * 2 + cd;
        const rolls = total / SCORE_PER_ROLL;

        // 主词条（可选）：按 mainFactor 系数折算，默认 0.33，仅作参考
        let mainScore = 0;
        const o = opts || {};
        if (o.includeMain && o.mainStats && o.mainStats.length) {
            const mainFactor = o.mainFactor !== undefined ? Number(o.mainFactor) : 0.33;
            for (let j = 0; j < o.mainStats.length; j++) {
                const m = o.mainStats[j];
                let sc = 0;
                if (FLAT_BASE[m.stat]) {
                    const b = base[FLAT_BASE[m.stat]] || BASE_DEFAULT[FLAT_BASE[m.stat]];
                    sc = (m.value / b) * 100 * (UNIT[FLAT_UNIT[m.stat]] || 1);
                } else {
                    sc = m.value * (UNIT[m.stat] || 0);
                }
                mainScore += sc * weightOf(m.stat, weights) * mainFactor;
            }
        }

        return {
            entries: entries,
            total: total,
            mainScore: mainScore,
            sum: total + mainScore,
            cv: cv,
            cr: cr,
            cd: cd,
            rolls: rolls
        };
    }

    function gradeOfOne(score) {
        if (score >= 49) return '极品';
        if (score >= 40) return '优秀';
        if (score >= 30) return '良好';
        if (score >= 20) return '一般';
        return '偏弱';
    }

    function gradeOfTotal(total) {
        const pct = (total / (5 * MAX_SCORE_PER_ARTIFACT)) * 100;
        let grade = '欠火候';
        if (pct >= 80) grade = '大毕业';
        else if (pct >= 67) grade = '毕业';
        else if (pct >= 55) grade = '良好';
        else if (pct >= 40) grade = '及格';
        return { percent: pct, grade: grade };
    }

    function round2(v) {
        return Math.round(v * 100) / 100;
    }

    //#endregion CORE

    // ============================================================
    // 运行环境适配层（BGI 全局：log / file / captureGameRegion / settings 等）
    // ============================================================

    const CFG_FILE = 'zones.json';
    const CHAR_FILE = 'characters.json';
    const STATE_FILE = 'score_state.json';

    const DEFAULT_CFG = {
        useZone: false,
        substatZone: { x: 0.55, y: 0.28, w: 0.33, h: 0.45 },
        filter: { hpFlat: 1500, atkFlat: 200, defFlat: 150, pct: 35, em: 150, er: 40 }
    };

    function safeLog(level, msg) {
        try {
            if (log && typeof log[level] === 'function') log[level](msg);
            else console.log(msg);
        } catch (e) {
            try { console.log(msg); } catch (e2) { /* ignore */ }
        }
    }
    const info = function (m) { safeLog('info', m); };
    const warn = function (m) { safeLog('warn', m); };

    function getSettings() {
        try {
            if (typeof settings !== 'undefined' && settings) return settings;
        } catch (e) { /* ignore */ }
        return {};
    }

    function readJsonFile(name, fallback, quiet) {
        try {
            if (file && typeof file.readTextSync === 'function') {
                const txt = file.readTextSync(name);
                if (txt) return JSON.parse(txt);
            }
        } catch (e) {
            if (!quiet) warn('读取 ' + name + ' 失败，使用内置默认值：' + e);
        }
        return fallback;
    }

    function prop(obj, lower, upper) {
        if (obj === null || obj === undefined) return undefined;
        try {
            const v = obj[lower];
            if (v !== undefined && v !== null) return v;
        } catch (e) { /* ignore */ }
        try {
            const v2 = obj[upper];
            if (v2 !== undefined && v2 !== null) return v2;
        } catch (e) { /* ignore */ }
        return undefined;
    }

    function numOr(v, dflt) {
        const n = Number(v);
        return isFinite(n) ? n : dflt;
    }

    // 抓取一帧并 OCR，返回 [{ text, x, y }]
    function captureTexts(cfg) {
        const out = [];
        let image = null;
        try {
            image = captureGameRegion();
            const w = numOr(prop(image, 'width', 'Width'), 1920);
            const h = numOr(prop(image, 'height', 'Height'), 1080);

            let ro = null;
            if (cfg && cfg.useZone && cfg.substatZone) {
                const z = cfg.substatZone;
                ro = RecognitionObject.ocr(z.x * w, z.y * h, z.w * w, z.h * h);
            } else if (RecognitionObject.ocrThis) {
                ro = RecognitionObject.ocrThis;
            } else {
                ro = RecognitionObject.ocr(0, 0, w, h);
            }

            const results = image.findMulti(ro);
            const n = numOr(prop(results, 'count', 'Count'), 0);
            for (let i = 0; i < n; i++) {
                const r = results[i];
                const t = prop(r, 'text', 'Text');
                if (t === undefined || t === null) continue;
                const text = String(t).trim();
                if (!text) continue;
                out.push({
                    text: text,
                    x: numOr(prop(r, 'x', 'X'), 0),
                    y: numOr(prop(r, 'y', 'Y'), 0)
                });
            }
        } finally {
            if (image) {
                try { image.dispose(); } catch (e) { /* ignore */ }
            }
        }
        return out;
    }

    function signatureOf(subs) {
        return subs
            .map(function (s) { return s.stat + s.value.toFixed(1); })
            .sort()
            .join('|');
    }

    function loadAllState() {
        // 记录文件首次运行时并不存在，属正常情况，不打印警告
        const data = readJsonFile(STATE_FILE, {}, true);
        return data && typeof data === 'object' ? data : {};
    }

    function loadState(charName) {
        const all = loadAllState();
        const st = all[charName];
        return {
            all: all,
            items: st && st.items ? st.items : []
        };
    }

    function saveState(charName, items) {
        const all = loadAllState();
        all[charName] = { items: items, updated: new Date().toString() };
        const text = JSON.stringify(all, null, 2);
        try {
            if (file && typeof file.writeTextSync === 'function') {
                file.writeTextSync(STATE_FILE, text);
                return true;
            }
            if (file && typeof file.writeText === 'function') {
                file.writeText(STATE_FILE, text);
                return true;
            }
        } catch (e) {
            warn('写入 ' + STATE_FILE + ' 失败（该记录仅保留在本次运行中）：' + e);
        }
        return false;
    }

    function fmt(v) {
        return (Math.round(v * 100) / 100).toFixed(2);
    }

    function printOne(index, result, profileName) {
        info('———————— 第 ' + index + ' 件 · 角色：' + profileName + ' ————————');
        for (let i = 0; i < result.entries.length; i++) {
            const e = result.entries[i];
            const statText = e.stat.indexOf('%') >= 0 || e.stat === '暴击率' || e.stat === '暴击伤害' || e.stat === '元素充能效率'
                ? e.value + '%'
                : e.value;
            info('  ' + e.stat + ' ' + statText + ' → ' + fmt(e.score) + ' 分（权重 ' + e.weight + '）');
        }
        info('  单件有效词条分：' + fmt(result.total) +
            '（约 ' + fmt(result.rolls) + ' 个词条，' + gradeOfOne(result.total) + '）');
        info('  单件双爆分：' + fmt(result.cv) + '（' + fmt(result.cr) + '% 暴击率 ×2 + ' + fmt(result.cd) + '% 爆伤）');
        if (result.mainScore > 0) {
            info('  主词条参考分：' + fmt(result.mainScore) + '（已计入总分）');
        }
    }

    function printSummary(charName, items) {
        const total = items.reduce(function (a, it) { return a + (it.score || 0); }, 0);
        const cvTotal = items.reduce(function (a, it) { return a + (it.cv || 0); }, 0);
        const g = gradeOfTotal(total);
        info('================ ' + charName + ' 套装总评 ================');
        info('  已记录件数：' + items.length + ' / 5');
        info('  总评分（有效词条分）：' + fmt(total) + '（约 ' + fmt(total / SCORE_PER_ROLL) + ' 个有效词条）');
        info('  毕业度：' + fmt(g.percent) + '% → ' + g.grade);
        info('  双爆总分：' + fmt(cvTotal));
        if (items.length >= 5) {
            info('  5 件已齐，可换角色继续统计；如需重算请用「清空该角色记录」模式。');
        }
        return { total: total, cv: cvTotal, grade: g };
    }

    // 标定模式：把屏幕上所有 OCR 文本连同坐标打出来，方便填 zones.json
    function calibrate() {
        info('==== 标定模式：请停在圣遗物详情页，下面输出本次 OCR 的全部文本 ====');
        const texts = captureTexts({ useZone: false });
        for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            const parsed = parseStatLine(t.text);
            let tag = '';
            if (parsed) {
                const sm = splitMainAndSub([t.text], null);
                tag = ' → 解析为 ' + parsed.stat + ' ' + parsed.value + '（' +
                    (sm.subs.length ? '副词条' : '主词条/仅主词条') + '）';
            }
            info('[' + t.x + ',' + t.y + '] ' + t.text + tag);
        }
        info('若副词条被主词条干扰，打开 zones.json 的 useZone 并调整 substatZone（x/y/w/h 为画面比例）。');
    }

    function resetState(charName) {
        const all = loadAllState();
        if (all[charName]) {
            delete all[charName];
            try {
                if (file && typeof file.writeTextSync === 'function') {
                    file.writeTextSync(STATE_FILE, JSON.stringify(all, null, 2));
                } else if (file && typeof file.writeText === 'function') {
                    file.writeText(STATE_FILE, JSON.stringify(all, null, 2));
                }
            } catch (e) {
                warn('清空记录写入失败：' + e);
            }
            info('已清空「' + charName + '」的记录。');
        } else {
            info('「' + charName + '」本来就没有记录。');
        }
    }

    function reviewState(profileName) {
        const st = loadState(profileName);
        if (!st.items.length) {
            info('「' + profileName + '」暂无记录，先跑一次识别模式吧。');
            return;
        }
        for (let i = 0; i < st.items.length; i++) {
            const it = st.items[i];
            info('第 ' + (i + 1) + ' 件：' + fmt(it.score) + ' 分（双爆 ' + fmt(it.cv) + '）· ' +
                (it.substats || []).map(function (s) { return s.stat + s.value; }).join(' / '));
        }
        printSummary(profileName, st.items);
    }

    // 单件计分：识别当前打开的圣遗物，累加进记录
    function onceMode(cfg, profile, profileName, opts) {
        const texts = captureTexts(cfg);
        const sm = splitMainAndSub(texts, cfg.filter);
        if (sm.subs.length < 2) {
            warn('只识别到 ' + sm.subs.length + ' 条副词条，请确认停在「圣遗物详情」页、且没有被弹窗遮挡。');
            calibHint(texts);
            return;
        }
        const result = scoreArtifact(sm.subs, profile, {
            includeMain: opts.includeMain,
            mainStats: sm.mains,
            mainFactor: opts.mainFactor
        });

        const st = loadState(profileName);
        st.items.push({
            ts: new Date().toString(),
            substats: sm.subs.map(function (s) { return { stat: s.stat, value: s.value }; }),
            score: round2(result.sum),
            cv: round2(result.cv),
            rolls: round2(result.rolls)
        });
        saveState(profileName, st.items);

        printOne(st.items.length, result, profileName);
        printSummary(profileName, st.items);
    }

    function calibHint(texts) {
        info('本次 OCR 到 ' + texts.length + ' 行文本，前 12 行供核对：');
        for (let i = 0; i < Math.min(texts.length, 12); i++) {
            info('  [' + texts[i].x + ',' + texts[i].y + '] ' + texts[i].text);
        }
        info('若文本明显缺失，请把游戏切到「无边框/窗口化」、关闭 HDR 后再试，或用标定模式检查区域。');
    }

    // 连扫模式：脚本持续截图，你手动依次点开 5 件圣遗物，识别到「换件」即自动记分
    async function scanMode(cfg, profile, profileName, opts) {
        const st = loadState(profileName);
        const seconds = Math.max(10, Math.min(600, numOr(opts.listenSeconds, 90)));

        info('开始连扫：' + seconds + ' 秒内，请在这段时间里依次点开「' + profileName +
            '」的 5 件圣遗物详情页，脚本会自动识别换件并记分。');
        info('当前已记录 ' + st.items.length + ' 件，凑满 5 件会自动收尾。');

        let lastSig = '';
        let pendingSig = '';
        let pendingCount = 0;
        const endAt = Date.now() + seconds * 1000;

        while (Date.now() < endAt && st.items.length < 5) {
            const texts = captureTexts(cfg);
            const sm = splitMainAndSub(texts, cfg.filter);

            if (sm.subs.length >= 2) {
                const sig = signatureOf(sm.subs);
                if (sig === pendingSig) {
                    pendingCount += 1;
                } else {
                    pendingSig = sig;
                    pendingCount = 1;
                }

                // 同一画面连续两帧一致 → 认为识别稳定；且与上一件不同 → 记为新的一件
                if (pendingCount >= 2 && sig !== lastSig) {
                    const result = scoreArtifact(sm.subs, profile, {
                        includeMain: opts.includeMain,
                        mainStats: sm.mains,
                        mainFactor: opts.mainFactor
                    });
                    st.items.push({
                        ts: new Date().toString(),
                        substats: sm.subs.map(function (s) { return { stat: s.stat, value: s.value }; }),
                        score: round2(result.sum),
                        cv: round2(result.cv),
                        rolls: round2(result.rolls)
                    });
                    saveState(profileName, st.items);
                    printOne(st.items.length, result, profileName);
                    lastSig = sig;
                }
            }

            await sleep(600);
        }

        if (st.items.length === 0) {
            warn('一次也没识别到，可能是没停在详情页，或者 OCR 区域设置不合适。');
            calibHint(captureTexts(cfg));
            return;
        }
        printSummary(profileName, st.items);
    }

    async function main() {
        const S = getSettings();
        const cfgRaw = readJsonFile(CFG_FILE, DEFAULT_CFG);
        const cfg = {
            useZone: cfgRaw.useZone === true,
            substatZone: cfgRaw.substatZone || DEFAULT_CFG.substatZone,
            filter: cfgRaw.filter || DEFAULT_CFG.filter
        };

        const chars = readJsonFile(CHAR_FILE, {});
        const profileName = String(S.character || '通用');
        const profile = chars[profileName] || chars['通用'] || {};
        if (!chars[profileName]) {
            warn('角色表里没有「' + profileName + '」，已回退到「通用」权重（全部词条按 1.0 计）。');
        }

        const mode = String(S.mode || '连扫五件（自动累加）');
        const opts = {
            includeMain: S.includeMain === true,
            mainFactor: numOr(S.mainFactor, 0.33),
            listenSeconds: numOr(S.listenSeconds, 90)
        };

        if (mode.indexOf('标定') >= 0) { calibrate(); return; }
        if (mode.indexOf('查看') >= 0) { reviewState(profileName); return; }
        if (mode.indexOf('清空') >= 0) { resetState(profileName); return; }
        if (mode.indexOf('单件') >= 0) { onceMode(cfg, profile, profileName, opts); return; }

        await scanMode(cfg, profile, profileName, opts);
    }

    await main();
})();
