// Shared vocabularies for shots, lenses, sensors and scene presets.

// frame: vertical extent (m) visible at the subject for a 1.75 m actor.
// aim: look-at height as a fraction of actor height.
// obj: frame as a multiple of a non-human subject's height.
export const SIZES = {
  ecu: { ko: '익스트림 클로즈업', short: 'ECU', en: 'extreme close-up', frame: 0.13, aim: 0.935, obj: 0.18, lens: 100 },
  cu: { ko: '클로즈업', short: 'CU', en: 'close-up', frame: 0.34, aim: 0.9, obj: 0.35, lens: 85 },
  mcu: { ko: '미디엄 클로즈업', short: 'MCU', en: 'medium close-up', frame: 0.58, aim: 0.85, obj: 0.55, lens: 65 },
  ms: { ko: '미디엄 샷', short: 'MS', en: 'medium shot', frame: 0.95, aim: 0.77, obj: 0.8, lens: 50 },
  mls: { ko: '미디엄 롱 샷', short: 'MLS', en: 'medium long shot (cowboy)', frame: 1.35, aim: 0.66, obj: 1.0, lens: 40 },
  fs: { ko: '풀 샷', short: 'FS', en: 'full shot', frame: 2.25, aim: 0.52, obj: 1.4, lens: 35 },
  ws: { ko: '와이드 샷', short: 'WS', en: 'wide shot', frame: 5.5, aim: 0.5, obj: 3, lens: 24 },
  ews: { ko: '익스트림 와이드', short: 'EWS', en: 'extreme wide establishing shot', frame: 18, aim: 0.5, obj: 9, lens: 18 },
};

export const ANGLES = {
  eye: { ko: '아이 레벨', en: 'eye-level', elev: 0 },
  high: { ko: '하이 앵글', en: 'high-angle', elev: 28 },
  low: { ko: '로우 앵글', en: 'low-angle', elev: -18 },
  overhead: { ko: '탑 뷰 (수직 부감)', en: 'top-down overhead', elev: 84 },
  worm: { ko: '웜즈 아이', en: "worm's-eye", elev: null },
};

// az: camera azimuth relative to the subject's facing direction (deg).
export const DIRS = {
  front: { ko: '정면', en: 'frontal', az: 0 },
  ql: { ko: '3/4 좌', en: 'three-quarter', az: 35 },
  qr: { ko: '3/4 우', en: 'three-quarter', az: -35 },
  side: { ko: '측면 (프로필)', en: 'profile', az: 90 },
  back: { ko: '뒷모습', en: 'from behind', az: 180 },
  ots: { ko: '오버숄더', en: 'over-the-shoulder', az: 0 },
};

export const MOVES = {
  static: { ko: '고정', en: 'static locked-off camera' },
  push: { ko: '달리 인 (푸시)', en: 'dolly-in push' },
  pull: { ko: '달리 아웃 (풀백)', en: 'dolly-out pull back' },
  truck_l: { ko: '트럭 좌', en: 'lateral truck left' },
  truck_r: { ko: '트럭 우', en: 'lateral truck right' },
  crane_up: { ko: '크레인 업', en: 'crane up' },
  crane_down: { ko: '크레인 다운', en: 'crane down' },
  orbit_l: { ko: '오빗 좌', en: 'orbiting left around the subject' },
  orbit_r: { ko: '오빗 우', en: 'orbiting right around the subject' },
  orbit_360: { ko: '오빗 360°', en: 'full 360-degree orbit around the subject' },
  track: { ko: '트래킹 (팔로우)', en: 'tracking shot following the subject' },
  pan_l: { ko: '팬 좌', en: 'pan left' },
  pan_r: { ko: '팬 우', en: 'pan right' },
  tilt_up: { ko: '틸트 업', en: 'tilt up' },
  tilt_down: { ko: '틸트 다운', en: 'tilt down' },
  whip_l: { ko: '휩 팬 좌', en: 'whip pan left' },
  whip_r: { ko: '휩 팬 우', en: 'whip pan right' },
  dolly_zoom: { ko: '달리 줌 (버티고)', en: 'dolly zoom (vertigo effect)' },
  drone: { ko: '드론 상승 풀백', en: 'rising aerial drone pull-back' },
};

export const SPEED = {
  slow: { ko: '천천히', en: 'slow', k: 0.55 },
  normal: { ko: '보통', en: 'smooth', k: 1 },
  fast: { ko: '빠르게', en: 'fast', k: 1.8 },
};

// w: sensor width in mm (horizontal for landscape frames).
export const SENSORS = {
  s35: { ko: 'Super 35 (24.9mm)', en: 'Super 35', w: 24.89 },
  ff: { ko: 'Full Frame (36mm)', en: 'full-frame', w: 36 },
  lf: { ko: 'ARRI Alexa LF (36.7mm)', en: 'large-format', w: 36.7 },
  m43: { ko: 'Micro 4/3 (17.3mm)', en: 'Micro Four Thirds', w: 17.3 },
  phone: { ko: '스마트폰 메인 (9.8mm)', en: 'smartphone', w: 9.8 },
};

export const ASPECTS = {
  '2.39': { ko: '2.39:1 시네마스코프', v: 2.39 },
  '1.85': { ko: '1.85:1 비스타', v: 1.85 },
  '1.78': { ko: '16:9', v: 16 / 9 },
  '0.5625': { ko: '9:16 세로', v: 9 / 16 },
  '1.33': { ko: '4:3', v: 4 / 3 },
  '1': { ko: '1:1', v: 1 },
};

export const LIGHTS = {
  day: { ko: '주간 (맑음)' },
  golden: { ko: '골든 아워' },
  overcast: { ko: '흐림' },
  night: { ko: '야간' },
  interior: { ko: '실내 스튜디오' },
  amber: { ko: '회상 (호박색)' },
  sunbreak: { ko: '구름 틈 햇빛' },
  paper: { ko: '연필 종이 톤 (흐림)' },
};

// height: types whose "height" field is editable, with the label shown in the inspector.
export const OBJ_TYPES = {
  actor: { ko: '인물', color: '#d9a066', height: 1.75, hLabel: '키 (m)' },
  car: { ko: '자동차', color: '#3d6fa8' },
  box: { ko: '박스', color: '#8a8f99', size: [1, 1, 1] },
  cylinder: { ko: '기둥', color: '#9aa0a6', size: [0.5, 3, 0.5] },
  wall: { ko: '벽', color: '#b9b2a6', size: [4, 3, 0.2] },
  tree: { ko: '나무', color: '#4f7d3a', height: 5, hLabel: '높이 (m)' },
  table: { ko: '테이블', color: '#7b5a3c', size: [1.4, 0.75, 0.8] },
  mark: { ko: '바닥 마크', color: '#ffcc33' },
  drums: { ko: '드럼 세트', color: '#1d1f23' },
  keyboard: { ko: '키보드', color: '#25272b', size: [1.25, 0.92, 0.38] },
  micstand: { ko: '마이크', color: '#2a2c30', height: 1.5, hLabel: '스탠드 높이 (m)' },
  balloon: { ko: '풍선', color: '#9cc3e6', size: [0.3, 0.36, 0.3], height: 1.6, hLabel: '끈 길이 (m)', tilt: true },
  slab: { ko: '바위판', color: '#8f8a82', size: [3, 0.6, 2.4], tilt: true },
  debris: { ko: '부유 파편', color: '#7d7973', size: [6, 3, 6] },
  metronome: { ko: '메트로놈', color: '#6b4a2f' },
  // A teardrop latex balloon whose glossy skin mirrors the live scene (cube-camera reflection).
  mballoon: { ko: '반사 풍선', color: '#9cc3e6', size: [0.3, 0.38, 0.3], height: 0, hLabel: '끈 길이 (m)', tilt: true },
  // A ring of cloud billboards around the origin; size = [radius, -, -].
  clouds: { ko: '구름층', color: '#ffffff', size: [400, 0, 0] },
  // Cracked-plate ground decal; size = [width, -, depth].
  crackfloor: { ko: '균열 지면', color: '#6f6c68', size: [60, 0, 60] },
};

// Poses per object type. The first entry is the default.
export const POSE_SETS = {
  actor: {
    stand: '서기 (걷기 포함)',
    look_up: '서서 올려다보기',
    sit: '앉기',
    drum: '드럼 연주',
    drum_fill: '드럼 필인 (탐을 내려다봄)',
    drum_look: '드럼 필인 → 카메라 응시 (샷 중반에 고개를 듦)',
    sticks_up: '스틱 치켜들기',
    kneel: '한쪽 무릎',
    kneel_up: '한쪽 무릎 · 올려다보기',
    guitar: '기타 · 베이스 연주',
    keys: '건반 연주',
    hold: '두 손 모으기 (얼굴 앞)',
    hug: '끌어안기 (가슴 앞)',
    reach_up: '한 손 뻗어 올리기',
    dissolve: '산화 (어깨부터 먼지로 흩어짐)',
  },
  metronome: { swing: '박자대로 흔들림', start: '시작 (가운데에서 천천히 커져 샷 끝에 최대 폭)', rest: '정지 (가운데)', slow: '점점 느려짐', stop: '정지 (한쪽 끝)' },
  debris: { float: '천천히 떠다님', still: '공중 정지' },
  balloon: { sway: '바람에 흔들림', circle: '원을 그리며 흔들림 (위에서 볼 때 시계 방향, 샷 동안 한 바퀴)', still: '정지' },
  mballoon: {
    circle: '원을 그리며 흔들림 (위에서 볼 때 시계 방향, 샷 동안 한 바퀴)',
    circle_turn: '원을 그리며 흔들림 + 반사 속 세상이 시계 방향으로 60° 회전 (연출용)',
    sway: '바람에 흔들림',
    still: '정지',
  },
  clouds: { drift: '왼쪽 → 오른쪽으로 흐름', still: '정지' },
};

export const HOLDS = { none: '없음', guitar: '일렉 기타', bass: '베이스', sticks: '드럼 스틱' };

export const ACTOR_COLORS = ['#d9a066', '#6fa8dc', '#e06666', '#93c47d', '#c27ba0', '#f6b26b'];
