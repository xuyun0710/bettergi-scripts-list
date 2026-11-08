// 评分内核自测：从 main.js 中抽取 #region CORE 段落，在 Node 里直接跑断言
// 用法：node tools/selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(here, '..', 'main.js');
const src = fs.readFileSync(mainPath, 'utf8');

const startMark = '//#region CORE';
const endMark = '//#endregion CORE';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
if (start < 0 || end < 0) {
    console.error('未找到 CORE 标记，无法自测');
    process.exit(2);
}
const coreLineEnd = src.indexOf('\n', start);
const coreCode = src.slice(coreLineEnd, end);

const api = new Function(
    coreCode +
    '\nreturn { parseStatLine, splitMainAndSub, scoreArtifact, gradeOfOne, gradeOfTotal, MAX_SCORE_PER_ARTIFACT };'
)();

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) {
        passed += 1;
        console.log('  PASS  ' + name + (extra ? '  ' + extra : ''));
    } else {
        failed += 1;
        console.log('  FAIL  ' + name + (extra ? '  ' + extra : ''));
    }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.05 : tol);

console.log('\n[1] 单行词条解析');
const p1 = api.parseStatLine('暴击率+7.8%');
check('暴击率百分比', p1 && p1.stat === '暴击率' && near(p1.value, 7.8), p1 && JSON.stringify(p1));

const p2 = api.parseStatLine('暴击伤害 14.0%');
check('暴击伤害带空格', p2 && p2.stat === '暴击伤害' && near(p2.value, 14.0), p2 && JSON.stringify(p2));

const p3 = api.parseStatLine('攻击力+45');
check('小攻击识别为固定值', p3 && p3.stat === '攻击力' && near(p3.value, 45), p3 && JSON.stringify(p3));

const p4 = api.parseStatLine('攻击力＋9.3％');
check('全角符号归一化', p4 && p4.stat === '攻击力%' && near(p4.value, 9.3), p4 && JSON.stringify(p4));

const p5 = api.parseStatLine('元素精通+23');
check('元素精通', p5 && p5.stat === '元素精通' && near(p5.value, 23), p5 && JSON.stringify(p5));

const p6 = api.parseStatLine('元素充能效率+5.2%');
check('元素充能效率', p6 && p6.stat === '元素充能效率' && near(p6.value, 5.2), p6 && JSON.stringify(p6));

const p7 = api.parseStatLine('火元素伤害加成+46.6%');
check('元素伤害加成', p7 && p7.stat === '元素伤害加成' && near(p7.value, 46.6), p7 && JSON.stringify(p7));

const p8 = api.parseStatLine('等级 +20');
check('非词条行返回 null', p8 === null, JSON.stringify(p8));

console.log('\n[2] 主词条 / 副词条拆分');
const sm = api.splitMainAndSub([
    '攻击力+46.6%',          // 沙漏主词条
    '暴击率+7.8%',
    '暴击伤害+21.0%',
    '生命值+4.7%',
    '元素精通+23',
    '生命值+4780'            // 花主词条
], null);
check('副词条 4 条', sm.subs.length === 4, '实际 ' + sm.subs.length);
check('主词条 2 条（含 4780 固定生命）', sm.mains.length === 2, '实际 ' + sm.mains.length);
check('46.6% 攻击被判定为主词条', sm.mains.some(m => m.stat === '攻击力%' && near(m.value, 46.6)));

const sm2 = api.splitMainAndSub(['火元素伤害加成+46.6%', '暴击率+3.1%', '暴击伤害+6.2%'], null);
check('元素伤害加成只进主词条', sm2.subs.length === 2 && sm2.mains.length === 1,
    'subs=' + sm2.subs.length + ' mains=' + sm2.mains.length);

console.log('\n[3] 单件评分（胡桃）');
const profile = JSON.parse(fs.readFileSync(path.join(here, '..', 'characters.json'), 'utf8'))['胡桃'];
const r = api.scoreArtifact([
    { stat: '暴击率', value: 7.8 },
    { stat: '暴击伤害', value: 14.0 },
    { stat: '生命值%', value: 4.7 },
    { stat: '元素精通', value: 23 }
], profile);

// 期望：7.8*2 + 14*1 + 4.7*1.3333*0.9 + 23*0.3333*0.5 = 15.6 + 14 + 5.64 + 3.83 = 39.07
check('总分 ≈ 39.07', near(r.total, 39.07, 0.1), '实际 ' + r.total.toFixed(2));
check('双爆分 = 29.6', near(r.cv, 29.6, 0.05), '实际 ' + r.cv.toFixed(2));
check('词条数 ≈ 5.92', near(r.rolls, 5.92, 0.05), '实际 ' + r.rolls.toFixed(2));
check('单件评级为良好（39 分档）', api.gradeOfOne(r.total) === '良好', api.gradeOfOne(r.total));

console.log('\n[4] 权重为 0 的词条不计分');
const nv = JSON.parse(fs.readFileSync(path.join(here, '..', 'characters.json'), 'utf8'))['那维莱特'];
const r2 = api.scoreArtifact([{ stat: '攻击力%', value: 10 }, { stat: '生命值%', value: 10 }], nv);
check('那维莱特：攻击% = 0 分', near(r2.total, 13.33, 0.1), '实际 ' + r2.total.toFixed(2));
check('那维莱特：攻击% 条目存在但分为 0', r2.entries[0].score === 0);

console.log('\n[5] 固定值词条折算');
const r3 = api.scoreArtifact([{ stat: '攻击力', value: 45 }], JSON.parse(fs.readFileSync(path.join(here, '..', 'characters.json'), 'utf8'))['神里绫华']);
// 45/774*100 = 5.81% → 5.81*1.3333*1.0*0.4 = 3.10
check('小攻击 45 折算 ≈ 3.10', near(r3.total, 3.10, 0.1), '实际 ' + r3.total.toFixed(2));

console.log('\n[6] 套装分级');
const g1 = api.gradeOfTotal(240);
check('240 分 → 大毕业', g1.grade === '大毕业', g1.grade + ' / ' + g1.percent.toFixed(1) + '%');
const g2 = api.gradeOfTotal(200);
check('200 分 → 毕业', g2.grade === '毕业', g2.grade + ' / ' + g2.percent.toFixed(1) + '%');
const g3 = api.gradeOfTotal(150);
check('150 分 → 及格', g3.grade === '及格', g3.grade + ' / ' + g3.percent.toFixed(1) + '%');
check('单件理论上限 = 59.4', near(api.MAX_SCORE_PER_ARTIFACT, 59.4, 0.01), String(api.MAX_SCORE_PER_ARTIFACT));

console.log('\n结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
