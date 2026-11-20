// 把 MIDI 转成可视化用的数据：音符（音高、起止秒、力度、左右手）+ 踏板区间
// 用法：node convert.cjs <@tonejs/midi 路径> <输入.mid> <输出.js>
const fs = require('fs');
const { Midi } = require(process.argv[2]);
const midi = new Midi(fs.readFileSync(process.argv[3]));
const notes = [], pedal = [];
midi.tracks.forEach((tr) => {
  const hand = (tr.name || '').toLowerCase().includes('left') ? 'L' : 'R';
  tr.notes.forEach(n => notes.push({ p: n.midi, t: +n.time.toFixed(4), d: +n.duration.toFixed(4), v: +n.velocity.toFixed(3), h: hand }));
  let on = null;
  (tr.controlChanges[64] || []).forEach(c => {
    if (c.value >= 0.5 && on === null) on = c.time;
    else if (c.value < 0.5 && on !== null) { pedal.push([+on.toFixed(4), +c.time.toFixed(4)]); on = null; }
  });
});
notes.sort((a, b) => a.t - b.t || a.p - b.p);
pedal.sort((a, b) => a[0] - b[0]);
const out = { duration: +midi.duration.toFixed(3), notes, pedal };
fs.writeFileSync(process.argv[4], 'window.SONG = ' + JSON.stringify(out) + ';\n');
console.log('notes', notes.length, 'dur', out.duration, 'pedal', pedal.length, 'range', Math.min(...notes.map(n => n.p)), Math.max(...notes.map(n => n.p)));
for (let s = 0; s < out.duration; s += 10) {
  const w = notes.filter(n => n.t >= s && n.t < s + 10);
  console.log(String(s).padStart(4), '#'.repeat(Math.round(w.length / 4)), w.length, w.length ? (w.reduce((a, n) => a + n.v, 0) / w.length).toFixed(2) : '');
}
