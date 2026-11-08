// 端到端 dry-run：用假的 BGI 环境跑一遍 main.js，验证 OCR → 解析 → 计分 → 存档链路
// 用法：node tools/mockrun.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const logs = [];
const writes = {};

globalThis.log = {
    info: (m) => logs.push('[info] ' + m),
    warn: (m) => logs.push('[warn] ' + m),
    error: (m) => logs.push('[error] ' + m),
    debug: (m) => logs.push('[debug] ' + m)
};

globalThis.settings = { character: '胡桃', mode: '单件计分', includeMain: false };

globalThis.file = {
    readTextSync: (name) => fs.readFileSync(path.join(root, name), 'utf8'),
    writeTextSync: (name, text) => { writes[name] = text; }
};

// 假的一件圣遗物：4 条副词条 + 1 条主词条（攻击力 46.6%）
const OCR_LINES = [
    { text: '攻击力+46.6%', x: 620, y: 300 },
    { text: '暴击率+7.8%', x: 1200, y: 420 },
    { text: '暴击伤害+14.0%', x: 1200, y: 470 },
    { text: '生命值+4.7%', x: 1200, y: 520 },
    { text: '元素精通+23', x: 1200, y: 570 },
    { text: '等级 +20', x: 700, y: 200 }
];

globalThis.RecognitionObject = { ocrThis: { kind: 'ocrThis' }, ocr: () => ({}) };

globalThis.captureGameRegion = () => {
    const results = { count: OCR_LINES.length };
    OCR_LINES.forEach((l, i) => { results[i] = { text: l.text, x: l.x, y: l.y }; });
    return { width: 1920, height: 1080, findMulti: () => results, dispose: () => {} };
};

globalThis.sleep = async () => {};

const code = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
await eval(code);

console.log(logs.join('\n'));

const state = writes['score_state.json'] ? JSON.parse(writes['score_state.json']) : null;
let ok = true;
if (!state || !state['胡桃'] || state['胡桃'].items.length !== 1) {
    console.error('\nFAIL：没有正确写入 1 件记录');
    ok = false;
} else {
    console.log('\n写入记录：' + JSON.stringify(state['胡桃'].items[0]));
}
const hasMainMixed = logs.join('\n').indexOf('攻击力% 46.6') >= 0;
if (hasMainMixed) {
    console.error('FAIL：主词条被误算进副词条');
    ok = false;
}
process.exit(ok ? 0 : 1);
