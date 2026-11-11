// Starter workflows. Nodes are [key, type, x, y, data]; links are "from.port>to.port".
function build(name, nodes, links) {
  return {
    version: 1, name,
    nodes: nodes.map(([id, type, x, y, data]) => ({ id, type, x, y, data: data || {} })),
    edges: links.map((l, i) => { const [a, b] = l.split('>'); const [fn, fp] = a.split('.'); const [tn, tp] = b.split('.'); return { id: `e${i}`, from: { node: fn, port: fp }, to: { node: tn, port: tp } }; }),
  };
}

const LOOK = 'Photorealistic live-action film still, shot on a full-frame cinema camera, 35mm lens, natural skin texture, soft motivated light, subtle film grain. No illustration, no CGI look.';

export const TEMPLATES = [
  {
    id: 'i2v', title: '시작 이미지 → 영상', hint: '가장 기본: 스틸을 만들고 그 스틸로 영상 생성',
    doc: () => build('시작 이미지 → 영상', [
      ['look', 'text', 0, 0, { label: '룩 (공통 화풍)', text: LOOK }],
      ['still', 'text', 0, 240, { label: '스틸 묘사', text: 'A woman in her 30s stands at a rain-soaked crosswalk at night, neon signs reflected on the wet asphalt, medium shot, eye level.' }],
      ['img', 'image', 380, 0, { label: '시작 이미지', model: 'nano_banana_pro', aspect: '16:9' }],
      ['move', 'text', 380, 620, { label: '움직임 묘사', text: 'She turns her head toward the camera and starts walking forward. Slow dolly in. Rain keeps falling.' }],
      ['vid', 'video', 800, 0, { label: '샷 1', model: 'seedance_2_5', aspect: '16:9', duration: '5', params: { mode: 'omni_reference' } }],
      ['note', 'note', 0, 480, { text: '스틸이 마음에 들 때까지 이미지 생성만 다시 돌리고,\n마음에 들면 메뉴(⋯)에서 "결과 잠금"을 건 뒤 영상을 실행하세요.' }],
    ], ['look.out>img.prompt', 'still.out>img.prompt', 'img.out>vid.start', 'move.out>vid.prompt']),
  },
  {
    id: 'character', title: '캐릭터 레퍼런스 멀티샷', hint: '캐릭터 시트 한 장을 여러 샷의 레퍼런스로',
    doc: () => build('캐릭터 레퍼런스 멀티샷', [
      ['look', 'text', 0, 0, { label: '룩 (공통 화풍)', text: LOOK }],
      ['who', 'text', 0, 240, { label: '캐릭터 설명', text: 'Korean man, late 20s, short black hair, grey wool coat over a black turtleneck, calm expression.' }],
      ['sheet', 'image', 380, 0, { label: '캐릭터 시트', model: 'nano_banana_pro', aspect: '16:9', prompt: 'Character reference sheet on a plain light-grey background: front view, three-quarter view and profile of the same person, consistent face and outfit, even studio lighting.' }],
      ['s1', 'text', 800, -700, { label: '샷 1 묘사', text: 'Wide shot. He walks out of a subway exit into morning light, crowd passing around him.' }],
      ['s2', 'text', 800, 60, { label: '샷 2 묘사', text: 'Close-up. He stops and looks up at something off-screen, wind moving his hair.' }],
      ['s3', 'text', 800, 820, { label: '샷 3 묘사', text: 'Over-the-shoulder shot. He faces a tall glass building, camera slowly cranes up.' }],
      ['v1', 'video', 1180, -700, { label: '샷 1', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['v2', 'video', 1180, 60, { label: '샷 2', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['v3', 'video', 1180, 820, { label: '샷 3', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['board', 'board', 1620, 60, { title: '시퀀스 A' }],
    ], ['look.out>sheet.prompt', 'who.out>sheet.prompt', 'sheet.out>v1.refs', 'sheet.out>v2.refs', 'sheet.out>v3.refs',
      'look.out>v1.prompt', 's1.out>v1.prompt', 'look.out>v2.prompt', 's2.out>v2.prompt', 'look.out>v3.prompt', 's3.out>v3.prompt',
      'v1.out>board.shots', 'v2.out>board.shots', 'v3.out>board.shots']),
  },
  {
    id: 'chain', title: '샷 이어 붙이기', hint: '앞 샷의 마지막 프레임을 다음 샷의 시작 이미지로',
    doc: () => build('샷 이어 붙이기', [
      ['p0', 'text', 0, 0, { label: '첫 스틸 묘사', text: `${LOOK}\nA cyclist waits at a red light on an empty city street at dawn, side view.` }],
      ['img', 'image', 380, 0, { label: '시작 이미지', model: 'nano_banana_pro', aspect: '16:9' }],
      ['p1', 'text', 380, 640, { label: '샷 1 움직임', text: 'The light turns green and the cyclist pushes off. Camera tracks alongside.' }],
      ['v1', 'video', 800, 0, { label: '샷 1', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['f1', 'frame', 1220, 0, { label: '샷 1 마지막 프레임', at: 'last' }],
      ['p2', 'text', 1220, 460, { label: '샷 2 움직임', text: 'The cyclist speeds up and turns the corner. Camera keeps tracking, then lets the rider leave the frame.' }],
      ['v2', 'video', 1560, 0, { label: '샷 2', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['board', 'board', 1980, 0, { title: '이어지는 시퀀스' }],
    ], ['p0.out>img.prompt', 'img.out>v1.start', 'p1.out>v1.prompt', 'v1.out>f1.video', 'f1.out>v2.start', 'p2.out>v2.prompt', 'v1.out>board.shots', 'v2.out>board.shots']),
  },
  {
    id: 'compare', title: '모델 비교', hint: '같은 시작 이미지·프롬프트를 여러 영상 모델에',
    doc: () => build('모델 비교', [
      ['img', 'media', 0, 0, { label: '시작 이미지', kind: 'image' }],
      ['p', 'text', 0, 420, { label: '움직임 묘사', text: 'Slow push-in. The subject breathes, blinks and shifts weight naturally. Photorealistic live-action footage.' }],
      ['a', 'video', 420, -760, { label: 'Seedance 2.5', model: 'seedance_2_5', duration: '5', params: { mode: 'omni_reference' } }],
      ['b', 'video', 420, 0, { label: 'Cinema Studio 3.0', model: 'cinematic_studio_3_0', duration: '5' }],
      ['c', 'video', 420, 700, { label: 'MiniMax H3', model: 'minimax_h3', duration: '5' }],
      ['board', 'board', 860, 0, { title: '모델 비교' }],
    ], ['img.out>a.start', 'img.out>b.start', 'img.out>c.start', 'p.out>a.prompt', 'p.out>b.prompt', 'p.out>c.prompt', 'a.out>board.shots', 'b.out>board.shots', 'c.out>board.shots']),
  },
];
