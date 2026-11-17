/* eslint-disable */
/**
 * Pokemon desktop pet — page-side runtime.
 *
 * Injected via CDP. Reads window.__QW_POKE_CFG__ (pushed by inject.js):
 *   { petHome, assetScheme, bridge, bgList[], pokeList[], foodList[], ballList[] }
 *
 * Feature set, all living inside the host app window:
 *   · background board layer with adjustable scope / opacity / blur
 *   · a team of up to 6 pokemon walking along the bottom, each independently
 *     draggable and feedable
 *   · feeding with the 24 real TCG items (food pops up, pokemon eats, hearts)
 *   · drag a pokemon to a window edge and it escapes to the standalone desktop
 *     app; "recall" brings it back into the window
 *   · visual picker for boards / team / food / settings, choices in localStorage
 *
 * Everything is namespaced with the `qwpoke-` prefix and a single global
 * `window.__qwPoke`, so re-injection and removal stay clean.
 */
(function () {
  'use strict';

  var CFG = window.__QW_POKE_CFG__ || {};
  var BG_LIST = CFG.bgList || [];
  var POKE_LIST = CFG.pokeList || [];
  var FOOD_LIST = CFG.foodList || [];
  var BALL_LIST = CFG.ballList || [];
  var MY_LIST = CFG.myList || [];          // pets built from the user's own photos
  var AVATAR_LIST = CFG.avatarList || []; // TCGP avatars / badges / coins
  var FX_LIST = CFG.fxList || [];         // TCGP battle particles
  var SLUGS = CFG.slugs || {};            // pokedex no -> showdown slug (shiny sprites)
  var MY_INDEX = CFG.myIndex || '';        // mypets/index.json, polled after upload
  var MY_PENDING = CFG.myPending || '';    // mypets/pending.json, the upload handshake
  var BRIDGE = CFG.bridge || '';
  // Whether a standalone desktop-pet app is actually installed. The skill package
  // does not ship one, so on most installs this is false and "jump to desktop"
  // must not pretend to work.
  var DESKTOP_READY = !!CFG.desktopReady;
  // Why it is off, phrased for the user. The old copy blamed a missing install,
  // which is wrong on macOS and sent people looking for a download.
  var DESKTOP_NOTE = CFG.desktopNote || '';
  var DESKTOP_REASON = CFG.desktopReason || '';
  /* Fallback copy per reason, used when inject did not send a note. Each one ends
     with the honest next step — "nothing to do here" included, because a false
     lead costs the user more than a plain no. */
  var DESKTOP_REASONS = {
    'mac-notarize': 'macOS 不支持把宠物放到桌面：桌面窗口必须由经过 Apple 公证的程序来开，' +
      '技能包带的程序只有临时签名会被系统杀掉。没有能自己打开的开关，' +
      '宠物留在窗口里一样能拖动、投喂、换背景板。',
    'win-lockdown': '这台电脑的 PowerShell 被公司策略限制（受限语言模式），画不出桌面窗口。' +
      '要用桌面模式得让 IT 放开 PowerShell 完整语言模式；' +
      '不方便的话就让宠物留在窗口里，功能一样全。',
    'missing-script': '缺少桌宠脚本文件（desktop-pet.ps1）。重新安装一次技能就能补上。',
    'unknown': '这台电脑暂时开不了桌面模式，宠物留在窗口里一样能玩。'
  };
  var SKILL_INFO = CFG.skillInfo || null;
  var SCHEME = CFG.assetScheme || 'local-file://';
  // where the artwork lives, and which HD sprite styles have actually been
  // downloaded — the page cannot check the disk itself
  var PET_HOME = CFG.petHome || '';
  var HD_STYLES = CFG.hdStyles || {};
  /* Evolution graph: no -> { stage, next:[ids], from }. `next` is the list of
     DIRECT successors, so a branching family stays a real choice instead of
     being walked as if it were a straight line. Empty = evolution disabled. */
  var EVOLUTIONS = CFG.evolutions || {};
  /* Mega / Primal forms: id -> { base, kind, zh, en }. Unlike ordinary evolution
     these are reversible, so they are a separate mechanism rather than a stage in
     the graph — see megaEvolve/megaRevert. */
  var FORMS = CFG.forms || {};
  // 4.4: types, sizes, genders, regional forms, evolution stones, card catalog
  var TYPES_DATA = CFG.typesData || {};     // "0025": { types:["electric"], gen:1, region:"kanto", height:4, weight:60 }
  var GENDERS_DATA = CFG.gendersData || {}; // "0025": { rate:4, dimorphic:true }
  var REGIONAL_FORMS = CFG.regionalForms || {}; // "0019-a": { base:"0019", kind:"alola", slug:..., zh:... }
  var STONES_DATA = CFG.stonesData || {};   // "fire-stone": { zh:"火之石", targets:{"0037":"0038",...} }
  var CARDS_MANIFEST = CFG.cardsManifest || { sets: [], total: 0 };
  var TERA_ICONS = CFG.teraIcons || {};    // { "fire": "/path/to/太晶_火_icon.png", ... }
  var TERA_FORMS = CFG.teraForms || {};    // { "0025-tera": { base:"0025", teraType:"flying", zh:... } }
  var TERA_ZH = {
    normal: '一般', fire: '火', water: '水', electric: '电', grass: '草',
    ice: '冰', fighting: '格斗', poison: '毒', ground: '地面', flying: '飞行',
    psychic: '超能力', bug: '虫', rock: '岩石', ghost: '幽灵', dragon: '龙',
    dark: '恶', steel: '钢', fairy: '妖精', stellar: '星晶'
  };
  var FEMALE_GIFS = CFG.femaleGifs || {};   // ids whose local <id>-f.gif was downloaded
  var TRAINER_LIST = CFG.trainerList || []; // [{id, zh, role, files:{modern,retro}}]
  var CARD_LIST = CFG.cardList || [];       // [{file,label,kind,path}] — only what is on disk
  var PACK_LIST = CFG.packList || [];       // 开包用的卡包封面（不进收藏册）
  var CARD_TOTAL = CFG.cardTotal || 0;      // manifest 声明的总数（下载进度用）
  var CARD_SETS = CFG.cardSets || [];       // [{id,zh,count}]
  var RARITY_ORDER = ['diamond1','diamond2','diamond3','diamond4','star1','star2','star3','crown'];
  var RARITY_ZH = { diamond1:'◊', diamond2:'◊◊', diamond3:'◊◊◊', diamond4:'◊◊◊◊',
                    star1:'☆', star2:'☆☆', star3:'☆☆☆', crown:'♛ 皇冠' };
  var CARD_TYPE_ZH = { G:'草', R:'火', W:'水', L:'电', P:'超', F:'斗', D:'恶', M:'钢',
                       Y:'龙', C:'一般', N:'无色',
                       // 训练家卡在源数据里用的是整词，不是单字母
                       Item:'物品', Supporter:'支援者', Tool:'宝可梦道具', Stadium:'竞技场',
                       I:'物品', Su:'支援者', T:'宝可梦道具' };
  var STAGE_ZH = { 'Basic': '基础', 'Stage 1': '一阶进化', 'Stage 2': '二阶进化' };
  /* Colour classes for the rarity pill. Kept alongside RARITY_ZH so a call site
     picks either plain text or a coloured chip and never spells "diamond1"
     inline (which would drift when the marketing renames a tier). */
  function rarityText(r, fallback) { return RARITY_ZH[r] || fallback || r || ''; }
  function rarityClass(r) { return r ? ('qwpoke-rar ' + r) : ''; }
  function rarityHTML(r, fallback) {
    var t = rarityText(r, fallback);
    if (!t) return '';
    var cls = rarityClass(r);
    // escape only the tiny surface: rarityText returns a fixed set of glyphs
    return '<span class="' + cls + '">' + t + '</span>';
  }

  /* Size map: height (in decimetres from PokeAPI) → display pixels.
   * Log scale so the range stays visible without extremes dominating:
   *   0.1m (height=1, e.g. Joltik) → 40px
   *   0.4m (height=4, Pikachu) → ~56px
   *   1.7m (height=17, Charizard) → ~96px
   *   6.5m (height=65, Gyarados) → ~128px
   *   14.5m (height=145, Wailord) → ~160px
   * Formula: px = 40 + 24 * ln(height)  (clamped to [40, 160])
   */
  var SIZE_MIN = 40, SIZE_MAX = 160;
  function heightToPx(h) {
    if (!h || h <= 0) return 72; // fallback: a sensible medium
    var px = Math.round(40 + 24 * Math.log(h));
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, px));
  }
  var SIZE_MAP = {};
  (function () {
    for (var id in TYPES_DATA) {
      if (TYPES_DATA[id].height) SIZE_MAP[id] = heightToPx(TYPES_DATA[id].height);
    }
    /* Forms carry their own numbers: an Alolan Vulpix is Ice (not Fire) and a
       Gigantamax Charizard is 28m tall (not 1.7m). Falling back to the base
       species here would mislabel and mis-size every one of them. */
    for (var fid in REGIONAL_FORMS) {
      var rf = REGIONAL_FORMS[fid];
      if (rf && rf.height) SIZE_MAP[fid] = heightToPx(rf.height);
    }
  })();

  /** Attribute record (types / gen / region / height) for any id, form-aware. */
  function attrOf(no) {
    var rf = REGIONAL_FORMS[no];
    if (rf && rf.types) {
      var base = TYPES_DATA[rf.base] || {};
      return { types: rf.types, gen: base.gen, region: base.region,
               height: rf.height, weight: rf.weight };
    }
    if (TYPES_DATA[no]) return TYPES_DATA[no];
    // mega / primal: forms.json has no types, so inherit from the base species
    var mf = FORMS[no];
    if (mf && TYPES_DATA[mf.base]) return TYPES_DATA[mf.base];
    return null;
  }


  /** Effective display size for a specific Pokémon.
   *  Priority: user per-pet override (sizeOverrides[no]) → species height-based (SIZE_MAP) → global default (petSize).
   *  The global slider acts as the fallback for species not in SIZE_MAP (custom pets, etc).
   */
  function petSizeOf(no) {
    if (S.sizeOverrides && S.sizeOverrides[no]) return S.sizeOverrides[no];
    return SIZE_MAP[no] || S.petSize;
  }

  /* ---------- gender ----------
   * gender_rate from PokeAPI is "how many eighths are female": -1 genderless,
   * 0 always male, 8 always female, 1-7 mixed. 102 species also look different
   * per gender, and Showdown serves those from a separate ani-f/ directory.
   */
  function genderRate(no) {
    var baseId = (FORMS[no] && FORMS[no].base) || (REGIONAL_FORMS[no] && REGIONAL_FORMS[no].base) || no;
    var g = GENDERS_DATA[baseId];
    return g && typeof g.rate === 'number' ? g.rate : -1;
  }
  function hasGender(no) { return genderRate(no) >= 0; }
  function canChooseGender(no) {
    var r = genderRate(no);
    return r > 0 && r < 8;            // fixed-gender species are not a choice
  }
  function isDimorphic(no) {
    var baseId = (FORMS[no] && FORMS[no].base) || (REGIONAL_FORMS[no] && REGIONAL_FORMS[no].base) || no;
    return !!(GENDERS_DATA[baseId] && GENDERS_DATA[baseId].dimorphic);
  }
  /* 102 个 dimorphic 物种里差异跨度极大：Pikachu ♀ 只是尾巴多个心形缺口，
   * Meowstic ♂ 却是蓝色 ♀ 是白色。给菜单展示提示语时按差异等级区分——
   * 只有"外形/主色一眼能分辨"的物种值得在按钮上写一句「不同性别外观差异明显」，
   * 其它 dimorphic 物种就是官方元数据，不值得占屏。列表按国民度和差异肉眼可见程度手工挑，
   * 数字是 dex 编号，中文名放在值里以便描述里直接引用。 */
  var MAJOR_DIMORPHIC = {
    '0450': '沙河马（♂ 深棕 · ♀ 米黄，官方差异最大之一）',
    '0521': '高傲雉鸡（♂ 头戴羽冠 · ♀ 眼周纹样，纹样完全不同）',
    '0592': '轻飘飘（♂ 蓝色 · ♀ 粉色，头冠数量也不同）',
    '0593': '胖嘟嘟水母（同 592，全身换色）',
    '0668': '火炎狮（♂ 有鬃毛 · ♀ 无鬃毛，体型差异明显）',
    '0678': '超能妙喵（♂ 主蓝 · ♀ 主白，几乎两只不同宝可梦）'
  };
  function isMajorDimorphic(no) {
    var baseId = (FORMS[no] && FORMS[no].base) || (REGIONAL_FORMS[no] && REGIONAL_FORMS[no].base) || no;
    return Object.prototype.hasOwnProperty.call(MAJOR_DIMORPHIC, baseId);
  }
  function majorDimorphicHint(no) {
    var baseId = (FORMS[no] && FORMS[no].base) || (REGIONAL_FORMS[no] && REGIONAL_FORMS[no].base) || no;
    return MAJOR_DIMORPHIC[baseId] || '';
  }
  /** Stored choice, else derived from the species ratio (deterministic per id). */
  function genderOf(no) {
    var r = genderRate(no);
    if (r < 0) return '';                       // genderless
    if (r === 0) return 'm';
    if (r === 8) return 'f';
    var saved = S.gender && S.gender[no];
    if (saved === 'm' || saved === 'f') return saved;
    /* No choice yet → male. This used to derive a gender by hashing the id, which
       handed Pikachu (rate 4) a female body and therefore the female sprite: a
       heart-notched tail nobody asked for, differing from the dex art the user
       recognises. A cosmetic difference must never appear on its own — the male
       sprite IS the dex baseline, so it is the only safe default. */
    return 'm';
  }
  function setGender(no, g) {
    if (!S.gender) S.gender = {};
    if (g === 'm' || g === 'f') S.gender[no] = g; else delete S.gender[no];
    saveSettings();
    applyPets();
  }
  var GENDER_SIGN = { m: '\u2642', f: '\u2640' };

  /* ---------- regional forms ----------
   * A regional form is a different look of the same species, not a stage: switching
   * is free, reversible, keeps the bond, and is not gated on affection. Only forms
   * whose sprite was actually downloaded are offered, so nothing turns into a
   * broken image. Gigantamax is excluded here — that one is a transformation and
   * lives with mega instead.
   */
  function regionalOptionsFor(no) {
    var out = [];
    // only offer from a base species, never from one regional form to another
    if (REGIONAL_FORMS[no] || FORMS[no]) return out;
    for (var id in REGIONAL_FORMS) {
      var r = REGIONAL_FORMS[id];
      if (r.base !== no || r.kind === 'gmax') continue;
      if (!entryOf(id)) continue;               // sprite not downloaded yet
      out.push({ id: id, zh: r.zh, kind: r.kind });
    }
    return out;
  }

  function switchRegional(fromNo, toNo) {
    var i = S.team.indexOf(fromNo);
    if (i < 0) return null;
    if (!entryOf(toNo)) return null;
    S.team[i] = toNo;
    // carry the bond and the choices across — it is the same creature
    if (!S.affection) S.affection = {};
    S.affection[toNo] = Math.max(Number(S.affection[toNo]) || 0, affectionOf(fromNo));
    delete S.affection[fromNo];
    if (S.gender && S.gender[fromNo]) { S.gender[toNo] = S.gender[fromNo]; delete S.gender[fromNo]; }
    if (S.nicknames && S.nicknames[fromNo]) { S.nicknames[toNo] = S.nicknames[fromNo]; delete S.nicknames[fromNo]; }
    if (S.sizeOverrides && S.sizeOverrides[fromNo]) { S.sizeOverrides[toNo] = S.sizeOverrides[fromNo]; delete S.sizeOverrides[fromNo]; }
    markUnlocked(toNo);
    saveSettings();
    applyPets();
    refreshGlow();
    return toNo;
  }


  /* Attribute type colors (HSL). Two badges per pokemon, placed at bottom-left of the sprite. */
  var TYPE_COLORS = {
    normal: '#A8A878', fire: '#F08030', water: '#6890F0', electric: '#F8D030',
    grass: '#78C850', ice: '#98D8D8', fighting: '#C03028', poison: '#A040A0',
    ground: '#E0C068', flying: '#A890F0', psychic: '#F85888', bug: '#A8B820',
    rock: '#B8A038', ghost: '#705898', dragon: '#7038F8', dark: '#705848',
    steel: '#B8B8D0', fairy: '#EE99AC'
  };
  var TYPE_ZH = {
    normal: '一般', fire: '火', water: '水', electric: '电', grass: '草',
    ice: '冰', fighting: '格斗', poison: '毒', ground: '地面', flying: '飞行',
    psychic: '超能力', bug: '虫', rock: '岩石', ghost: '幽灵', dragon: '龙',
    dark: '恶', steel: '钢', fairy: '妖精'
  };
  var REGION_ZH = {
    kanto: '关都', johto: '城都', hoenn: '丰缘', sinnoh: '神奥', unova: '合众',
    kalos: '卡洛斯', alola: '阿罗拉', galar: '伽勒尔', paldea: '帕底亚',
    hisui: '洗翠'          // a form kind that is not a generation region
  };
  // user-facing copy — this skill runs inside more than one AI workspace.
  var HOST = (CFG.hostName && CFG.hostName !== 'the app') ? CFG.hostName : '主窗口';
  /* Stable per-host key for appearance only. It is derived from the canonical
   * userData directory by the daemon, never from a localized display name. */
  var HOST_KEY = CFG.hostKey ? String(CFG.hostKey) : 'default';
  // platform hint for copy only (the page itself is platform-agnostic)
  var IS_WIN = /win/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || '')) &&
               !/mac/i.test(navigator.platform || '');

  var IDS = {
    style: 'qwpoke-style',
    bg: 'qwpoke-bg',
    layer: 'qwpoke-layer',
    btn: 'qwpoke-btn',
    picker: 'qwpoke-picker'
  };
  var LS = 'qwpoke.settings.v1';
  var MAX_TEAM = 6;
  /* How far the right rail sits from the window edge. Small enough to read as
     "in the right column", big enough that the sprite is never clipped. */
  var RAIL_GAP = 8;
  /** Normalised placement mode — never trust the stored string directly. */
  function placement() {
    var p = S && S.petPlacement;
    return (p === 'free' || p === 'right') ? p : 'bottom';
  }

  // ---------- settings ----------
  var DEFAULTS = {
    bgFile: null,           // null = no background board
    bgScope: 'window',      // window | content | sidebar
    bgFit: '',              // '' = cover（背景板）; 'contain' = 完整展示（卡牌）
    bgOpacity: 0.5,
    bgBlur: 0,
    /* Sprite art style: 'pixel' (animated, the default), 'home' or 'artwork'.
       The HD styles are optional downloads and are still images — they trade the
       idle animation for detail, which only pays off at larger pet sizes. */
    spriteStyle: 'pixel',
    panelAlpha: 0.82,       // alpha of the app's own panels; lower = board shows through
    /* The same numbers do not work in both themes: the light theme paints dark
       text on a whitened surface, the dark theme paints near-white text on a
       darkened one. A board that is pleasant at 0.38 in light leaves dark-theme
       text unreadable, so each theme keeps its own pair and the sliders write
       whichever pair is live. */
    bgOpacityDark: 0.62,
    panelAlphaDark: 0.74,
    /* 背景板鲜艳度。1 = 原图饱和度。之前这里被硬编码成 0.78/0.85，配合提亮把
       卡牌插画洗得发灰，而浓度滑块管不到滤镜，所以用户拉满浓度也救不回来。
       文字可读性其实由 veil + panelAlpha 兜底，不需要靠洗白整张图。 */
    bgVivid: 1.12,
    bgVividDark: 1.15,
    team: ['0025'],         // up to 6 pokedex numbers
    petSize: 96,
    sizeOverrides: {},        // per-pet size override: { "0025": 60, "0130": 140 }
    gender: {},               // per-pet gender choice: { "0025": "f" }
    teraType: {},             // per-pet tera type: { "0025": "electric" }  null = not terastallized
    trainerId: '',            // which登场角色 stands beside the team ('' = none)
    trainerShow: false,       // off by default: it is an extra figure on screen
    trainerStyle: 'modern',   // modern | retro — Showdown really ships both
    trainerSize: 96,
    /* Collection: which items are owned, how many unopened packs are banked, and
       the per-day feeding counter that earns them. */
    cards: {},                // { "TCGP_xxx.png": 1 }
    packs: 0,                 // unopened packs
    packLog: {},              // one-off earn markers: bond100:<no> / evo:<no>
    feedDay: '',              // yyyy-m-d of the current feeding day
    feedCount: 0,             // feeds today (earns a pack each, capped)
    cardFav: {},              // ♥ 收藏的卡：{ "A1_001.webp": 1 }
    packSet: '',              // 上次选的扩充包，开包默认沿用
    /* Where the pets live. Three deliberate modes rather than one on/off switch:
       'bottom' walks the window floor, 'right' walks the right-hand column (out of
       the way of the text you are reading), 'free' means they stay exactly where
       you dropped them. */
    petPlacement: 'bottom',
    /* Saved drop points for 'free', keyed by roster entry. Persisting these is
       not optional: the daemon re-injects the runtime whenever it finds the page
       without it, and an unsaved position would jump back to the default spread
       every time that happened. */
    petPos: {},
    petWalk: true,          // legacy 4.1 switch; migrated into petPlacement on load
    petsEnabled: true,
    escapeToDesktop: true,
    escapedTo: [],          // who is currently out on the desktop
    ballId: null,           // launcher icon; null = poke-ball / first available
    avatarFile: null,       // replaces the host app's own avatar when set
    fxShape: null,          // TCGP particle shape played around the pets
    idleActions: true,      // play the desktop-pet idle action set
    /* Care reminders: the pet bubbles a gentle nudge every so often. */
    careBubbles: true,
    /* Agent watch: the pet reacts to the host's own task lifecycle — cheers when
       a run finishes, raises a hand when a run is waiting for the user to confirm.
       DOM anchors are host-version-specific, and every one of them fails silent,
       so having this on by default cannot produce errors — only fewer notices. */
    agentWatch: true,
    /* External reminders pushed in over the local bridge (POST /notify). The pet
       is only a sink, it never fetches anything itself. Off by default: nothing
       should be able to make the pet talk until the user opts in, even though the
       push can only come from this machine. */
    extNotices: false,
    /* One-shot marker for the 4.2 notice defaults. Care/agent notices became
       on-by-default in 4.2, but existing installs carry a saved settings blob, so
       changing DEFAULTS alone would never reach them — loadSettings flips them
       once and records that it did. Do not reuse this key for later migrations. */
    noticeDefaults42: false,
    careMinutes: 10,
    /*
     * Reminder copy, grouped by what triggers it. Grouping is not decoration: the
     * three interval kinds rotate so you never get "drink water" three times in a
     * row, the meal/sleep sets fire off the wall clock instead of an interval, and
     * the sleep set escalates by how late it is. All of it is user-editable.
     *
     * The first line of water / sit / eyes is the original 4.1 copy, kept so an
     * upgrade does not silently drop the wording people already know.
     */
    noticeMsgs: {
      water: [
        '补水完成，HP 回复了一点点。',
        '水杯空了，这是最容易补的一格血。',
        '一口水的时间就够，不会耽误这场对战。',
        '干燥状态下，火属性会更难受哦——喝点水吧。',
        '不需要精灵球，伸手就能拿到的回复道具，就在你桌上。',
        '持续战斗中，别忘了随时补水。',
        '我帮你留着进度，你去喝水。',
        '水分不足会降低命中率的。',
        '树果慢慢吃，水要现在喝——这句我说过，但还是要说。',
        '三小时没喝水了，该补一格了。'
      ],
      sit: [
        '坐太久了，换我上场，你去走两步。',
        '连续战斗太久，速度会下降的。起来伸展一下吧。',
        '你已经在同一格站了很久了。',
        '站起来走 10 步，就当在草丛里探路。',
        '肩膀好像僵住了——转两圈试试。',
        '长时间不动会陷入「麻痹」状态哦。',
        '换个姿势，也是一种恢复技能。',
        '去接杯水顺便走一圈，一次解决两件事。'
      ],
      eyes: [
        '屏幕的光有点刺眼……闭上眼睛 20 秒，我帮你看着。',
        'PP 快用完了，休息一下才能继续放招。',
        '看远一点的地方，20 秒就好。',
        '眼睛也需要回复道具，闭眼就是。',
        '盯着屏幕太久，会降低回避率的。',
        '深呼吸三次，我们再继续。',
        '这一轮先交给我，你放空一会儿。'
      ],
      lunch: [
        '训练家也要恢复体力的哦，该去吃饭了。',
        '食堂方向探测到美味的气息！',
        '12 点了，全世界的宝可梦都在吃饭。',
        '先吃饭，下午的路还长。',
        '午餐是最好的回复道具，而且免费。',
        '再晚就要排队了，现在出发正好。'
      ],
      dinner: [
        '再不吃饭，下一场对战会因为「饥饿」陷入异常状态。',
        '18 点了，收拾一下去吃晚饭吧。',
        '今天的战斗差不多了，先补充体力。',
        '饿着继续打，只会一直失误。',
        '吃完再回来，我在这儿等你。'
      ],
      sleepEarly: [
        '今天打得不错，开始收尾吧。',
        '这场对战不用今天打完，撤退也是一种战术。'
      ],
      sleepLate: [
        '回宝可梦中心吧，我们把 HP 全部恢复，明天再出发。',
        '夜深了，连夜行性的宝可梦都准备睡了。',
        '熬夜不会加经验值，只会掉状态。',
        '存档吧，明天从这里继续。'
      ],
      sleepOvernight: [
        '已经过零点了，今天的记录到此为止。',
        '再撑下去，明天一整天都是异常状态。',
        '我先去睡了……你也一样，好吗？',
        '宝可梦中心的灯都关了，只剩你还在。'
      ],
      done: [
        '做得好！获得了经验值！',
        '这枚徽章，是你今天努力的证明。',
        '效果绝佳！一击解决。',
        '搞定一件，进度条又前进了。',
        '这一招练得越来越熟了。',
        '等级提升了！',
        '刚才那下很漂亮，我看见了。'
      ],
      start: [
        '准备好了吗？就决定是你了——今天的第一件事！',
        '今天的冒险，从这里开始。',
        '第一步最难，走出去就顺了。',
        '先挑一个最简单的对手热身。',
        '我在你身边，放心开打。'
      ]
    },
    shiny: false,           // use shiny sprites (loaded from showdown)
    /* Bond points per roster entry, 0..100. Earned by feeding and by the pet
       simply keeping you company; at full it may evolve. Keyed by pokedex number
       like the roster itself, so two of the same species share a bond. */
    affection: {},
    /* Everstone (不变之石): entries the user has decided must never evolve.
       Reversible — the pet's own menu offers to take the stone back. */
    everstone: {},
    /* Who has already evolved at least once, so they can keep a faint gold aura
       as a permanent mark. Distinct from the bright pulse that means "ready". */
    evolved: {},
    unlocked: {},          // forms the user has actually obtained: { "0038": 1 }
    panelPos: null,         // {x,y} where the user dragged the picker; null = default spot
    seenVersion: '',        // last version the pet already announced
    lastUpdateCheck: 0,     // ms epoch of the last remote update check
    nicknames: {}           // id -> nickname
  };

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {}
    // migrate the older single-pet shape to a team
    if (!s.team && s.petNo) s.team = [s.petNo];
    if (s.petEnabled !== undefined && s.petsEnabled === undefined) s.petsEnabled = s.petEnabled;
    var out = {};
    for (var k in DEFAULTS) out[k] = (s[k] === undefined ? DEFAULTS[k] : s[k]);
    if (!Array.isArray(out.team)) out.team = DEFAULTS.team.slice();
    out.team = out.team.slice(0, MAX_TEAM);
    if (!Array.isArray(out.escapedTo)) out.escapedTo = [];
    /* A saved blob edited by hand (or written by an older build) can hold a
       non-object here; every read below assumes a map, so normalise once. */
    ['affection', 'everstone', 'evolved', 'nicknames', 'petPos', 'sizeOverrides', 'gender', 'cards', 'packLog', 'unlocked', 'cardFav'].forEach(function (k) {
      if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
    });
    /* 4.2: the old boolean "walk along the bottom" became a three-way placement.
       Someone who had switched walking off wanted their pets to stay put, which
       is exactly 'free' — so carry that intent over instead of resetting them. */
    if (['bottom', 'right', 'free'].indexOf(s.petPlacement) < 0) {
      out.petPlacement = (s.petWalk === false) ? 'free' : 'bottom';
    }
    // The 特效 tab was removed; without this an install that had picked a shape
    // would keep spawning particles with no UI left to turn them off.
    out.fxShape = null;
    /*
     * 4.2: care + agent notices are on by default. An install from before 4.2 has
     * a saved blob where both keys are present and false, so the new DEFAULTS
     * would never reach it — flip them once, then remember that we did so a later
     * deliberate "off" is respected forever.
     */
    if (!s.noticeDefaults42) {
      out.careBubbles = true;
      out.agentWatch = true;
      out.noticeDefaults42 = true;
      try { localStorage.setItem(LS, JSON.stringify(out)); } catch (e) {}
    }
    /*
     * 4.2: the flat `careMsgs` array became `noticeMsgs`, grouped by trigger.
     * Rebuild the object defensively — a saved blob may hold the old array, a
     * partial object from a mid-upgrade state, or (if someone edited by hand)
     * junk in a bucket. Missing or empty buckets fall back to the shipped copy,
     * because a bucket that ends up empty means that reminder silently stops
     * firing with no way for the user to tell why.
     */
    var lib = {};
    var saved = (s.noticeMsgs && typeof s.noticeMsgs === 'object') ? s.noticeMsgs : {};
    for (var bucket in DEFAULTS.noticeMsgs) {
      var lines = Array.isArray(saved[bucket])
        ? saved[bucket].map(function (m) { return String(m == null ? '' : m).trim(); })
            .filter(function (m) { return m; })
        : [];
      lib[bucket] = lines.length ? lines : DEFAULTS.noticeMsgs[bucket].slice();
    }
    /* Lines the user had written into the old textarea join the water rotation —
       it is the closest match and beats dropping their wording on the floor.
       The three shipped 4.1 defaults are deliberately NOT carried over: they were
       generic wellness nags ("主人，该喝水啦！") that broke the pokemon voice, so they
       are listed below only to be recognised and discarded. */
    if (Array.isArray(s.careMsgs)) {
      var OLD_DEFAULT = ['主人，该喝水啦！', '休息一下眼睛吧，看看远处~', '坐久了要站起来走走哦！'];
      s.careMsgs.forEach(function (m) {
        var t = String(m == null ? '' : m).trim();
        if (!t || OLD_DEFAULT.indexOf(t) >= 0) return;
        var known = false;
        for (var b in lib) if (lib[b].indexOf(t) >= 0) known = true;
        if (!known) lib.water.push(t);
      });
    }
    out.noticeMsgs = lib;
    delete out.careMsgs;        // superseded; keeping it around invites drift
    return out;
  }

  /* Background settings used to live only in each host's localStorage. Switching
     workspaces or clearing site data therefore looked like the board had vanished,
     even though all 162 image files were still on disk. Mirror this coherent bundle
     through the daemon's state.json with last-write-wins semantics. */
  var APPEARANCE_KEYS = ['bgFile', 'bgScope', 'bgFit', 'bgOpacity', 'bgBlur',
    'panelAlpha', 'bgOpacityDark', 'panelAlphaDark', 'bgVivid', 'bgVividDark'];
  var appearanceSig = '';
  function appearanceValues(obj) {
    var out = {};
    APPEARANCE_KEYS.forEach(function (k) {
      // Keep explicit null ("no background") — it is a real user choice.
      out[k] = (obj && obj[k] !== undefined) ? obj[k] : DEFAULTS[k];
    });
    return out;
  }
  function appearanceSignature(obj) { return JSON.stringify(appearanceValues(obj)); }
  function appearancePayload() {
    var out = appearanceValues(S);
    out._ts = Number(S.appearanceUpdatedAt) || 0;
    return out;
  }

  function saveSettings() {
    var sig = appearanceSignature(S);
    // A real visual change gets a new timestamp. Unrelated saves (feeding/team/etc.)
    // must not claim the appearance is newer and overwrite another host's board.
    if (appearanceSig && sig !== appearanceSig) S.appearanceUpdatedAt = Date.now();
    appearanceSig = sig;
    try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {}
    // mirror the growth + appearance data to disk so it survives host switches/updates
    try { pushGrowth(); } catch (e) {}
  }
  var S = loadSettings();
  appearanceSig = appearanceSignature(S);
  // One-time migration: an existing chosen board becomes the first authoritative
  // disk snapshot. A fresh host with no board and no timestamp cannot erase it.
  if (S.bgFile && !(Number(S.appearanceUpdatedAt) > 0)) {
    S.appearanceUpdatedAt = Date.now();
    try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {}
    setTimeout(function () { try { pushGrowth(); } catch (e) {} }, 0);
  }

  /* Board density is theme-scoped: these resolve to the live theme's pair.
     themeIsDark is set by applyTheme() before anything paints. */
  function densKey(base) { return themeIsDark ? base + 'Dark' : base; }
  function bgOpacityNow() {
    var v = S[densKey('bgOpacity')];
    return typeof v === 'number' ? v : DEFAULTS[densKey('bgOpacity')];
  }
  function panelAlphaNow() {
    var v = S[densKey('panelAlpha')];
    return typeof v === 'number' ? v : DEFAULTS[densKey('panelAlpha')];
  }
  function bgVividNow() {
    var v = S[densKey('bgVivid')];
    return typeof v === 'number' ? v : DEFAULTS[densKey('bgVivid')];
  }
  function setDensity(base, v) {
    S[densKey(base)] = v;
    saveSettings();
  }

  /*
   * Asset transport. Two very different hosts must work:
   *  - 'local': the client registered our `local-file://` scheme and its CSP
   *    allows it, so <img src> is synchronous and nothing else is needed.
   *  - 'ws': a VS Code based IDE, where CSP is `img-src 'self' data: blob:
   *    https:` and `connect-src 'self' https: ws:`. local-file:// images AND the
   *    http bridge are both blocked; only ws:// + blob: get through, so bytes are
   *    streamed from the daemon over a WebSocket and wrapped in blob: URLs.
   * inject.js picks the mode by actually loading a sprite, never by product name.
   */
  var TRANSPORT = (CFG.transport === 'ws' && CFG.wsUrl) ? 'ws'
    : (CFG.transport === 'http' && CFG.bridge) ? 'http' : 'local';
  var WS_URL = CFG.wsUrl || '';
  /* Placeholder standing in for a not-yet-streamed asset. Call sites stay
     synchronous (`img.src = assetUrl(f)`); the fixup below rewrites them once the
     bytes land, so none of the ~20 asset sites had to become async. */
  var ASSET_MARK = 'qwpoke-asset:';
  var assetBlob = {};       // absolute path -> blob: URL
  var assetWaiting = {};    // absolute path -> true while a request is in flight
  var wsSock = null;
  var wsReqId = 0;
  var wsPending = {};       // id -> { resolve }
  var wsExpectBin = null;   // id whose binary frame comes next

  function wsConnect() {
    if (TRANSPORT !== 'ws' || !WS_URL) return null;
    if (wsSock && (wsSock.readyState === 0 || wsSock.readyState === 1)) return wsSock;
    try { wsSock = new WebSocket(WS_URL); } catch (e) { return null; }
    wsSock.binaryType = 'arraybuffer';
    wsSock.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.kind === 'asset') {
          if (!msg.ok) {
            var p0 = wsPending[msg.id];
            if (p0) { delete wsPending[msg.id]; p0.resolve(null); }
            return;
          }
          wsExpectBin = msg.id;                  // bytes arrive in the next frame
        } else if (msg.kind === 'bridge') {
          var pb = wsPending[msg.id];
          if (pb) { delete wsPending[msg.id]; pb.resolve(msg.result || null); }
        }
        return;
      }
      var id = wsExpectBin; wsExpectBin = null;
      var pa = wsPending[id];
      if (!pa) return;
      delete wsPending[id];
      pa.resolve(ev.data);
    };
    wsSock.onclose = function () { wsSock = null; };
    wsSock.onerror = function () { /* a later request reconnects */ };
    return wsSock;
  }

  function wsSend(msg) {
    var sock = wsConnect();
    if (!sock) return Promise.resolve(null);
    var id = ++wsReqId;
    msg.id = id;
    return new Promise(function (resolve) {
      wsPending[id] = { resolve: resolve };
      var fire = function () { try { sock.send(JSON.stringify(msg)); } catch (e) { resolve(null); } };
      if (sock.readyState === 1) fire();
      else sock.addEventListener('open', fire, { once: true });
      // never leave a caller hanging on a dead socket
      setTimeout(function () { if (wsPending[id]) { delete wsPending[id]; resolve(null); } }, 15000);
    });
  }

  /** Stream one file over the ws channel; resolves to an ArrayBuffer or null. */
  function wsAssetBytes(pathStr) { return wsSend({ kind: 'asset', path: pathStr }); }

  /** Same channel, decoded as text — for the small JSON files the page polls. */
  function wsAssetText(pathStr) {
    return wsAssetBytes(pathStr).then(function (buf) {
      if (!buf) return null;
      try { return new TextDecoder('utf-8').decode(new Uint8Array(buf)); } catch (e) { return null; }
    });
  }

  /*
   * http transport: this host's CSP blocks ws:// AND fetch() to 127.0.0.1
   * (no connect-src exception), but img-src allows plain http: and frame-src
   * allows http://127.0.0.1:*. So images point straight at the daemon's
   * /asset endpoint, and bridge calls / text reads ride a hidden iframe
   * loaded from the daemon (a CSP-free page, same-origin with the bridge,
   * doing the fetch on our behalf and postMessaging the reply back).
   */
  var relayFrame = null;
  var relayReady = null;
  var relayPending = {};
  var relaySeq = 0;

  function relayEnsure() {
    if (relayReady) return relayReady;
    if (!BRIDGE) return Promise.resolve(null);
    relayReady = new Promise(function (resolve) {
      var settled = false;
      var finish = function (f) { if (!settled) { settled = true; resolve(f); } };
      var f = document.createElement('iframe');
      f.id = 'qwpoke-relay';
      f.style.cssText = 'display:none;width:0;height:0;border:0;';
      f.src = BRIDGE + '/relay';
      f.onload = function () { finish(f); };
      setTimeout(function () { finish(null); }, 6000);
      (document.body || document.documentElement).appendChild(f);
      relayFrame = f;
    });
    window.addEventListener('message', function (ev) {
      if (!relayFrame || ev.source !== relayFrame.contentWindow) return;
      var d = ev.data;
      if (!d || d.__pokepet !== true) return;
      var p = relayPending[d.id];
      if (p) { delete relayPending[d.id]; p(d.result); }
    });
    return relayReady;
  }

  function relaySend(msg) {
    return relayEnsure().then(function (f) {
      if (!f) return null;
      var id = ++relaySeq;
      msg.__pokepet = true;
      msg.id = id;
      return new Promise(function (resolve) {
        relayPending[id] = resolve;
        try {
          f.contentWindow.postMessage(msg, '*');
        } catch (e) { delete relayPending[id]; resolve(null); }
        // never leave a caller hanging on a dead frame
        setTimeout(function () {
          if (relayPending[id]) { delete relayPending[id]; resolve(null); }
        }, 15000);
      });
    });
  }

  /** MIME type so the blob decodes as an image instead of a download. */
  function mimeOf(p) {
    var e = String(p).toLowerCase();
    if (/\.gif$/.test(e)) return 'image/gif';
    if (/\.png$/.test(e)) return 'image/png';
    if (/\.jpe?g$/.test(e)) return 'image/jpeg';
    if (/\.webp$/.test(e)) return 'image/webp';
    if (/\.svg$/.test(e)) return 'image/svg+xml';
    if (/\.json$/.test(e)) return 'application/json';
    return 'application/octet-stream';
  }

  /* Swap placeholders for real blob URLs — on every DOM change and right after
     each asset lands, so an <img> created before its bytes arrived still shows. */
  function fixupAssets(root) {
    if (TRANSPORT !== 'ws') return;
    var scope = (root && root.querySelectorAll) ? root : document;
    var els = scope.querySelectorAll('img[src^="' + ASSET_MARK + '"], [style*="' + ASSET_MARK + '"]');
    [].forEach.call(els, function (el) {
      var src = el.getAttribute && el.getAttribute('src');
      if (src && src.indexOf(ASSET_MARK) === 0) {
        var p = decodeURIComponent(src.slice(ASSET_MARK.length));
        if (assetBlob[p]) el.src = assetBlob[p]; else requestAsset(p);
        return;
      }
      var st = el.getAttribute && el.getAttribute('style');
      if (st && st.indexOf(ASSET_MARK) >= 0) {
        var m = st.match(new RegExp(ASSET_MARK + '([^"\'\\)\\s]+)'));
        if (!m) return;
        var q = decodeURIComponent(m[1]);
        if (assetBlob[q]) el.setAttribute('style', st.split(ASSET_MARK + m[1]).join(assetBlob[q]));
        else requestAsset(q);
      }
    });
  }

  var assetObserver = null;
  function startAssetFixup() {
    if (TRANSPORT !== 'ws' || assetObserver) return;
    try {
      assetObserver = new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (r.type === 'attributes') fixupAssets(r.target.parentNode || document);
          else if (r.addedNodes && r.addedNodes.length) fixupAssets(document);
        }
      });
      assetObserver.observe(document.documentElement,
        { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
    } catch (e) { /* fixupAssets still runs after every arrival */ }
  }

  function requestAsset(pathStr) {
    if (assetBlob[pathStr] || assetWaiting[pathStr]) return;
    assetWaiting[pathStr] = true;
    wsAssetBytes(pathStr).then(function (buf) {
      delete assetWaiting[pathStr];
      if (!buf) return;
      try { assetBlob[pathStr] = URL.createObjectURL(new Blob([buf], { type: mimeOf(pathStr) })); }
      catch (e) { return; }
      fixupAssets(document);
    });
  }

  /**
   * Absolute filesystem path -> asset URL.
   *
   * Must normalise, not just concatenate: a Windows path (`C:\x\y.png`) pasted
   * behind `local-file://` fails URL parsing outright — backslash is a forbidden
   * host code point and `C:` parses as host+port. POSIX paths already start with
   * `/` so mac behaviour is unchanged. Mirrors platform.js `toAssetUrl()`.
   */
  function assetUrl(p) {
    var u = String(p).replace(/\\/g, '/');
    if (u.charAt(0) !== '/') u = '/' + u;          // C:/x -> /C:/x
    // http host: img-src allows plain http: but nothing else, so point <img>
    // straight at the daemon's /asset endpoint (same allowlist as the ws channel).
    if (TRANSPORT === 'http') return BRIDGE + '/asset?path=' + encodeURIComponent(u);
    // A ws host has no usable URL scheme for local files: hand back a cached
    // blob: URL, or a placeholder that fixupAssets() rewrites when bytes arrive.
    if (TRANSPORT !== 'ws') return SCHEME + u;
    if (assetBlob[u]) return assetBlob[u];
    requestAsset(u);
    return ASSET_MARK + encodeURIComponent(u);
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /**
   * Call the native bridge and RESOLVE WITH ITS REPLY.
   *
   * This used to use `mode:'no-cors'`, which makes the response opaque — the
   * daemon's `{ok:...}` was thrown away, so callers could not tell success from
   * failure. That is how "drag to desktop" could remove a pokemon from the team
   * even when the standalone app never started. The daemon sends
   * Access-Control-Allow-Origin, so a normal request can read the body;
   * text/plain keeps it a "simple request" so there is no preflight round-trip.
   * Resolves to the parsed JSON, or null when the bridge is unreachable.
   */
  function bridgeCall(action, payload) {
    // http host: connect-src blocks both ws and fetch to 127.0.0.1, but the
    // hidden /relay iframe is same-origin WITH the bridge and fetches for us.
    if (TRANSPORT === 'http') return relaySend({ kind: 'bridge', action: action, payload: payload || {} });
    // On a ws host `connect-src` blocks http to 127.0.0.1 outright, so the same
    // call goes through the daemon's WebSocket relay instead.
    if (TRANSPORT === 'ws') return wsSend({ kind: 'bridge', action: action, payload: payload || {} });
    if (!BRIDGE) return Promise.resolve(null);
    try {
      return fetch(BRIDGE + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload || {})
      }).then(function (r) {
        if (!r || !r.ok) return null;
        return r.json().catch(function () { return null; });
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /** Compare dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal. */
  function cmpVersion(a, b) {
    var pa = String(a || '').split('.').map(Number);
    var pb = String(b || '').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /** Say something through whichever pokemon is on screen. */
  function petSpeak(lines) {
    var pet = PETS[0];
    if (!pet || !pet.showTip) return;
    var i = 0;
    var say = function () {
      if (i >= lines.length) return;
      var l = lines[i++];
      pet.showTip(l.text, l.ms);
      setTimeout(say, l.ms + 350);
    };
    say();
  }

  /**
   * Let the pet announce version news.
   *
   * Two independent things:
   *  · just updated  — the installed version differs from the one it last
   *    announced, so tell the user what changed (offline, always on).
   *  · update available — only when the user configured `updateFeed`; the pet
   *    then mentions that a newer version exists. No network otherwise.
   */
  function announceVersion() {
    if (!SKILL_INFO || !SKILL_INFO.version) return;
    var cur = SKILL_INFO.version;

    if (S.seenVersion !== cur) {
      var note = (SKILL_INFO.changelog || {})[cur] || '';
      var first = S.seenVersion ? '我升级到 v' + cur + ' 了 ✨' : '你好，我是 v' + cur + ' 的我 ✨';
      var lines = [{ text: first, ms: 2600 }];
      if (note) lines.push({ text: note, ms: 4600 });
      setTimeout(function () { petSpeak(lines); }, 5000);   // let the UI settle first
      S.seenVersion = cur;
      saveSettings();
    }

    var feed = SKILL_INFO.updateFeed;
    if (!feed || !/^https:\/\//.test(feed)) return;        // opt-in only, https only
    var DAY = 24 * 60 * 60 * 1000;
    if (Date.now() - (S.lastUpdateCheck || 0) < DAY) return;
    S.lastUpdateCheck = Date.now();
    saveSettings();
    fetch(feed, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.version || cmpVersion(j.version, cur) <= 0) return;
        var tip = (j.changelog || {})[j.version] || '';
        var lines = [{ text: '有新版 v' + j.version + ' 啦，重装一次就能更新', ms: 5200 }];
        if (tip) lines.push({ text: tip, ms: 4600 });
        setTimeout(function () { petSpeak(lines); }, 9000);
      })
      .catch(function () {});
  }

  /**
   * Resolve a team slot to a sprite. A slot is either a pokedex number
   * ('0025') or a custom pet id ('my:xxx'), so both lists are searched.
   */
  function entryOf(id) {
    var i;
    for (i = 0; i < POKE_LIST.length; i++) {
      if (POKE_LIST[i].no === id) {
        return { id: id, file: POKE_LIST[i].file, label: POKE_LIST[i].zh || POKE_LIST[i].en || id };
      }
    }
    for (i = 0; i < MY_LIST.length; i++) {
      if (MY_LIST[i].id === id) {
        return { id: id, file: MY_LIST[i].file, label: MY_LIST[i].name || '我的宠物' };
      }
    }
    return null;
  }
  function nameOf(id) {
    var e = entryOf(id);
    return e ? e.label : id;
  }
  function ballUrl() {
    if (!BALL_LIST.length) return null;
    var pick = null, i;
    if (S.ballId) {
      for (i = 0; i < BALL_LIST.length; i++) if (BALL_LIST[i].id === S.ballId) { pick = BALL_LIST[i]; break; }
    }
    if (!pick) {
      for (i = 0; i < BALL_LIST.length; i++) if (BALL_LIST[i].id === 'poke-ball') { pick = BALL_LIST[i]; break; }
    }
    if (!pick) pick = BALL_LIST[0];
    return assetUrl(pick.file);
  }

  // ---------- styles ----------
  function ensureStyle() {
    var old = document.getElementById(IDS.style);
    if (old) old.remove();
    var st = document.createElement('style');
    st.id = IDS.style;
    st.textContent = [
      '#' + IDS.bg + '{position:fixed;pointer-events:none;z-index:0;',
      '  background-position:center center;background-size:cover;background-repeat:no-repeat;',
      '  transition:opacity .35s ease, filter .35s ease;}',
      /* 竖版卡牌当背景板：单用 contain 会在两侧留下两条空白，看着像没加载完。
         所以底衬放一份放大糊掉的同图填满整块区域，卡片本体完整居中压在上面。 */
      '#' + IDS.bg + ' .qwpoke-bgblur{position:absolute;inset:0;background-position:center center;',
      '  background-size:cover;background-repeat:no-repeat;transform:scale(1.15);',
      '  filter:blur(26px) saturate(1.15);}',
      '#' + IDS.bg + ' .qwpoke-bgcard{position:absolute;inset:0;background-position:center center;',
      '  background-size:contain;background-repeat:no-repeat;',
      '  filter:drop-shadow(0 10px 30px rgba(0,0,0,.45));}',
      /* Palette. Every colour the skin paints goes through these variables, so
         flipping theme only swaps values instead of restyling anything. The
         defaults are the light theme; html.qwpoke-dark (set by applyTheme)
         overrides them. */
      ':root{--qwp-bg:#fff;--qwp-fg:#222;--qwp-fg2:#555;--qwp-sub:#888;',
      '  --qwp-line:#eee;--qwp-line2:#f0f1f3;--qwp-bd:#e2e4e8;--qwp-chip:#f2f3f5;',
      '  --qwp-chip-fg:#444;--qwp-cell:#f6f7f9;--qwp-cell2:#eceef1;--qwp-sw:#d7dae0;',
      '  --qwp-acc:#3b7cff;--qwp-acc-fg:#fff;--qwp-hover:#f4f6f9;',
      '  --qwp-scrim:rgba(15,20,30,.5);--qwp-tip:rgba(255,255,255,.96);--qwp-tip-fg:#333;}',
      'html.qwpoke-dark{--qwp-bg:#1b1e25;--qwp-fg:#e9ebf0;--qwp-fg2:#b7bdc9;--qwp-sub:#8c94a4;',
      '  --qwp-line:#2c313a;--qwp-line2:#272b34;--qwp-bd:#3a4150;--qwp-chip:#282d37;',
      '  --qwp-chip-fg:#c9cfdb;--qwp-cell:#232833;--qwp-cell2:#2b3040;--qwp-sw:#3b414d;',
      '  --qwp-acc:#4c8dff;--qwp-acc-fg:#fff;--qwp-hover:#2a303b;',
      '  --qwp-scrim:rgba(4,6,10,.62);--qwp-tip:rgba(26,30,38,.96);--qwp-tip-fg:#e9ebf0;}',
      /* Only when a board is active do we thin the app's own surfaces.
         The class list is a fast path for the common panels; anything else that
         covers the board is found at runtime by sampling (see tagSurfaces).
         The tint colour follows the theme: whitening a dark theme leaves its
         near-white text sitting on a near-white surface, i.e. unreadable. */
      '.qwpoke-board .agents-layout-root{background-color:rgba(var(--qwpoke-veil-rgb,255,255,255),var(--qwpoke-veil,0.5)) !important;}',
      'html.qwpoke-board .qwpoke-surface-base.qwpoke-surface-base{background-color:transparent!important;background-image:none!important;}',
      '.qwpoke-board .agents-chat-panel,',
      '.qwpoke-board .agents-parchment-paper-surface,',
      '.qwpoke-board .workbench-card,',
      '.qwpoke-board .workbench-stack-view,',
      '.qwpoke-board .qwpoke-surface-light{background-color:rgba(var(--qwpoke-surface,255,255,255),var(--qwpoke-panel,0.82)) !important;}',
      '.qwpoke-board .qwpoke-surface-dark{background-color:rgba(22,24,30,var(--qwpoke-panel,0.82)) !important;}',
      /* pet layer */
      '#' + IDS.layer + '{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;}',
      '.qwpoke-pet{position:fixed;left:0;top:0;pointer-events:none;will-change:transform;user-select:none;}',
      '.qwpoke-pet .qwpoke-sprite{display:block;width:100%;height:100%;object-fit:contain;',
      '  object-position:bottom center;image-rendering:pixelated;-webkit-user-drag:none;',
      '  pointer-events:auto;cursor:grab;',
      '  transform-origin:50% 100%;}',
      '.qwpoke-pet.qwpoke-dragging .qwpoke-sprite{cursor:grabbing;}',
      '.qwpoke-pet .qwpoke-food{position:absolute;left:50%;bottom:34%;image-rendering:pixelated;',
      '  transform:translateX(-50%) scale(0);opacity:0;pointer-events:none;z-index:3;',
      '  transition:transform .25s cubic-bezier(.34,1.56,.64,1), opacity .2s;',
      '  filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));}',
      '.qwpoke-pet .qwpoke-hearts{position:absolute;inset:0;pointer-events:none;z-index:4;}',
      '.qwpoke-pet .qwpoke-heart{position:absolute;font-size:15px;opacity:0;color:#ff4d6d;',
      '  text-shadow:0 0 4px rgba(255,120,150,.8);}',
      '.qwpoke-pet .qwpoke-tip{position:absolute;left:50%;top:-24px;transform:translateX(-50%);',
      '  background:var(--qwp-tip);color:var(--qwp-tip-fg);font:12px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      '  padding:3px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.2);',
      '  opacity:0;transition:opacity .2s;pointer-events:none;z-index:5;}',
      '.qwpoke-pet.qwpoke-hint .qwpoke-tip{opacity:1;}',
      /* Gold states. drop-shadow rather than box-shadow: it follows the sprite's
         alpha outline, while box-shadow would draw a halo around the square. */
      '.qwpoke-pet.qwpoke-ready .qwpoke-sprite{',
      '  filter:drop-shadow(0 0 8px rgba(255,215,0,.9)) drop-shadow(0 0 18px rgba(255,180,0,.55));',
      '  animation:qwpoke-gold 1.6s ease-in-out infinite;}',
      '@keyframes qwpoke-gold{',
      '  0%,100%{filter:drop-shadow(0 0 6px rgba(255,215,0,.7)) drop-shadow(0 0 14px rgba(255,180,0,.4));}',
      '  50%{filter:drop-shadow(0 0 14px rgba(255,215,0,1)) drop-shadow(0 0 28px rgba(255,180,0,.75));}}',
      /* Already evolved: the same gold, kept faint and still, as a quiet badge —
         it must not compete with the pulse that means "click me". */
      '.qwpoke-pet.qwpoke-evolved .qwpoke-sprite{',
      '  filter:drop-shadow(0 0 5px rgba(255,215,0,.42));}',
      /* A mega form gets its own colour rather than more gold: gold already means
         "bond full / evolution business", and a mega is a different thing that can
         be switched off again. Slow pulse so it reads as powered-up, not urgent. */
      '.qwpoke-pet.qwpoke-gmax .qwpoke-sprite{',
      '  filter:drop-shadow(0 0 10px rgba(255,60,60,.95)) drop-shadow(0 0 20px rgba(255,120,40,.6));}',
      '.qwpoke-pet.qwpoke-mega .qwpoke-sprite{',
      '  filter:drop-shadow(0 0 8px rgba(150,120,255,.85)) drop-shadow(0 0 20px rgba(90,140,255,.5));',
      '  animation:qwpoke-megapulse 2.4s ease-in-out infinite;}',
      '@keyframes qwpoke-megapulse{',
      '  0%,100%{filter:drop-shadow(0 0 6px rgba(150,120,255,.65)) drop-shadow(0 0 16px rgba(90,140,255,.35));}',
      '  50%{filter:drop-shadow(0 0 13px rgba(170,140,255,1)) drop-shadow(0 0 30px rgba(90,140,255,.7));}}',
      /* Bond badge on a roster cell. Sits top-left so it never collides with the
         remove (✕) and rename (✎) controls in the top-right. */
      '.qwpoke-cell .qwpoke-aff{position:absolute;left:3px;top:3px;z-index:3;',
      '  padding:1px 5px;border-radius:8px;font-size:10px;line-height:1.5;',
      '  background:rgba(0,0,0,.55);color:#fff;pointer-events:none;}',
      '.qwpoke-cell .qwpoke-aff.full{background:rgba(255,196,0,.92);color:#4a3200;font-weight:600;}',
      /* Two different "not yours yet" states, styled differently on purpose:
         · .uncollected (album) keeps the grey→colour reveal, which IS the reward
         · .locked (roster) stays in FULL COLOUR — greying out a thousand sprites
           made the list unpleasant to look through, so a small padlock carries the
           signal instead of draining the artwork. */
      '.qwpoke-cell.uncollected img{filter:grayscale(1) brightness(.45) contrast(.85);opacity:.7;}',
      '.qwpoke-cell.uncollected .qwpoke-cap{color:var(--qwp-sub);}',
      '.qwpoke-cell{position:relative;}',
      '.qwpoke-cell .qwpoke-lock{position:absolute;right:3px;top:3px;font-size:11px;line-height:1;',
      '  opacity:.92;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.7);}',
      '.qwpoke-cell.locked .qwpoke-cap{color:var(--qwp-sub);}',
      /* 卡牌网格：卡是主角，密度让位于展示。5:7 是实卡比例，一行 4 张 */
      '.qwpoke-grid.card{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;}',
      '.qwpoke-grid.card .qwpoke-cell{aspect-ratio:5/7;border-radius:9px;overflow:hidden;padding:0;}',
      '.qwpoke-grid.card .qwpoke-cell img{width:100%;height:100%;object-fit:cover;}',
      '.qwpoke-grid.card .qwpoke-cap{position:absolute;left:0;right:0;bottom:0;padding:3px 5px;',
      '  background:linear-gradient(transparent,rgba(0,0,0,.78));color:#fff;font-size:10px;}',
      '.qwpoke-cardtag{position:absolute;left:4px;top:4px;padding:1px 5px;border-radius:6px;',
      '  background:rgba(0,0,0,.6);color:#ffd76b;font-size:9px;line-height:1.6;pointer-events:none;}',
      '.qwpoke-fav{position:absolute;right:4px;top:4px;font-size:13px;line-height:1;cursor:pointer;',
      '  text-shadow:0 1px 4px rgba(0,0,0,.8);z-index:3;}',
      /* 开包：卡包立起、撕开、卡片滑出 */
      '.qwpoke-open{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;',
      '  justify-content:center;background:rgba(8,10,16,.88);backdrop-filter:blur(3px);}',
      '.qwpoke-openpack{position:relative;width:230px;height:322px;border-radius:12px;overflow:hidden;',
      '  box-shadow:0 18px 50px rgba(0,0,0,.6);animation:qwpoke-packin .5s cubic-bezier(.2,1.3,.4,1);}',
      '.qwpoke-openpack img{width:100%;height:100%;object-fit:cover;}',
      '@keyframes qwpoke-packin{0%{transform:translateY(40px) scale(.85);opacity:0;}100%{transform:none;opacity:1;}}',
      '.qwpoke-openpack.tearing{animation:qwpoke-shake .5s ease-in-out;}',
      '@keyframes qwpoke-shake{0%,100%{transform:rotate(0);}20%{transform:rotate(-2.5deg);}',
      '  50%{transform:rotate(2.5deg);}80%{transform:rotate(-1.5deg);}}',
      '.qwpoke-tearline{position:absolute;left:0;right:0;top:16%;height:3px;pointer-events:none;',
      '  background:repeating-linear-gradient(90deg,#fff 0 7px,transparent 7px 13px);opacity:.9;}',
      '.qwpoke-torn{position:absolute;left:0;right:0;top:0;height:16%;background:inherit;',
      '  transform-origin:bottom center;transition:transform .55s ease-in,opacity .55s;}',
      '.qwpoke-openpack.opened .qwpoke-torn{transform:rotateX(-115deg) translateY(-14px);opacity:0;}',
      '.qwpoke-openhint{position:absolute;bottom:-34px;left:0;right:0;text-align:center;color:#e9e9ef;',
      '  font-size:12px;}',
      /* 直接连戴正面：一张卡淡入 + 一次扫光即可，"翻转"那一秒本来就没在给用户新信息。 */
      '.qwpoke-shot{position:absolute;inset:0;border-radius:14px;overflow:hidden;',
      '  box-shadow:0 16px 44px rgba(0,0,0,.55);cursor:pointer;',
      '  animation:qwpoke-shotin .38s cubic-bezier(.2,1.2,.4,1);}',
      '.qwpoke-shot img{width:100%;height:100%;object-fit:contain;background:#0d1020;',
      '  display:block;}',
      '@keyframes qwpoke-shotin{0%{transform:scale(.86);opacity:0;}100%{transform:scale(1);opacity:1;}}',
      '.qwpoke-shot:after{content:"";position:absolute;inset:0;pointer-events:none;',
      '  background:linear-gradient(105deg,transparent 38%,rgba(255,255,255,.5) 50%,transparent 62%);',
      '  transform:translateX(-120%);animation:qwpoke-shine .62s ease-out .1s;}',
      '@keyframes qwpoke-shine{0%{transform:translateX(-120%);}100%{transform:translateX(120%);}}',
      '.qwpoke-revealbar{position:absolute;bottom:-40px;left:0;right:0;text-align:center;color:#e9e9ef;font-size:12px;}',
      /* 稀有度色片：图案 + 颜色，一眼分辨钻/星/皇冠三档，同档内深浅递进。
         钻：铜→银→金→白金；星：淡金→琥珀→绯红；皇冠：紫金渐变。 */
      '.qwpoke-rar{display:inline-block;padding:0 6px;border-radius:6px;font-size:10px;',
      '  font-weight:600;line-height:1.6;color:#111;letter-spacing:0;white-space:nowrap;}',
      '.qwpoke-rar.diamond1{background:#d7c3a8;}',
      '.qwpoke-rar.diamond2{background:#c9d1d9;}',
      '.qwpoke-rar.diamond3{background:#f0c36d;}',
      '.qwpoke-rar.diamond4{background:#e0edff;color:#1c3d66;}',
      '.qwpoke-rar.star1{background:#ffe27a;}',
      '.qwpoke-rar.star2{background:#ff9a55;}',
      '.qwpoke-rar.star3{background:#ff5d6c;color:#fff;}',
      '.qwpoke-rar.crown{background:linear-gradient(105deg,#c58bff 0%,#ffd76b 100%);color:#241a3d;',
      '  box-shadow:0 0 8px rgba(198,139,255,.55);}',
      /* 抽完的总览：五张一起看一眼，再决定要不要点开某张 */
      '.qwpoke-summary{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:min(86vw,660px);}',
      '.qwpoke-sumtitle{color:#ffd76b;font-size:14px;font-weight:600;}',
      '.qwpoke-sumgrid{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.qwpoke-sumgrid figure{margin:0;width:104px;text-align:center;color:#e9e9ef;font-size:10px;',
      '  animation:qwpoke-pop .4s ease-out backwards;}',
      '.qwpoke-sumgrid img{width:104px;height:146px;object-fit:contain;border-radius:8px;',
      '  background:#0d1020;box-shadow:0 8px 22px rgba(0,0,0,.5);cursor:pointer;display:block;}',
      '.qwpoke-sumgrid figcaption{margin-top:4px;line-height:1.45;}',
      '.qwpoke-sumhint{color:#a9b0c8;font-size:11px;}',
      /* 选包：卡包封面自己就是按钮，文字只做补充 */
      '.qwpoke-grid.pack{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:11px;}',
      '.qwpoke-grid.pack .qwpoke-cell{aspect-ratio:5/7;border-radius:10px;overflow:hidden;padding:0;}',
      '.qwpoke-grid.pack .qwpoke-cell img{width:100%;height:100%;object-fit:cover;}',
      '.qwpoke-grid.pack .qwpoke-cap{position:absolute;left:0;right:0;bottom:0;padding:4px 5px;',
      '  background:linear-gradient(transparent,rgba(0,0,0,.82));color:#fff;font-size:10px;line-height:1.4;}',
      '.qwpoke-grid.pack .qwpoke-cell.on{outline:2px solid #f0a020;outline-offset:-2px;}',
      /* 选中包后的详情区：左边大封面 + 撕开按钮，右边横向浏览包内所有卡 */
      '.qwpoke-packdetail{display:grid;grid-template-columns:200px 1fr;gap:14px;',
      '  margin:12px 0 6px;padding:12px;border:1px solid var(--qwp-line);border-radius:12px;',
      '  background:var(--qwp-cell);}',
      '.qwpoke-packleftcol{display:flex;flex-direction:column;align-items:center;gap:10px;}',
      '.qwpoke-bigcover{width:200px;aspect-ratio:5/7;border-radius:12px;overflow:hidden;',
      '  box-shadow:0 8px 22px rgba(0,0,0,.28);background:#0d1020;}',
      '.qwpoke-bigcover img{width:100%;height:100%;object-fit:cover;display:block;}',
      /* 缺封面占位：不是错误也不是加载中，只是这个 set 的卡包封面 wiki 还没上传 */
      '.qwpoke-bigcover-empty{display:flex;align-items:center;justify-content:center;',
      '  color:var(--qwp-sub);font-size:13px;letter-spacing:0.05em;',
      '  background:repeating-linear-gradient(45deg,var(--qwp-cell) 0 12px,var(--qwp-cell2) 12px 24px);}',
      '.qwpoke-grid.pack .qwpoke-cell.qwpoke-packnocover img{opacity:0;}',
      '.qwpoke-grid.pack .qwpoke-cell.qwpoke-packnocover:before{content:"封面暂缺";position:absolute;',
      '  inset:0;display:flex;align-items:center;justify-content:center;color:var(--qwp-sub);',
      '  font-size:11px;letter-spacing:0.05em;',
      '  background:repeating-linear-gradient(45deg,var(--qwp-cell) 0 8px,var(--qwp-cell2) 8px 16px);}',
      /* fallback：真正的卡包封面没上传，暂用组内一张卡代替。用一枚小徽章说明。 */
      '.qwpoke-grid.pack .qwpoke-cell .qwpoke-packfb{position:absolute;right:4px;bottom:16px;',
      '  padding:1px 5px;border-radius:6px;background:rgba(0,0,0,.62);color:#ffd76b;',
      '  font-size:9px;line-height:1.6;pointer-events:none;}',
      '.qwpoke-bigcover-fallback{position:relative;}',
      '.qwpoke-bigcover-fbbadge{position:absolute;left:0;right:0;bottom:0;padding:4px 6px;',
      '  background:linear-gradient(transparent,rgba(0,0,0,.75));color:#ffd76b;',
      '  font-size:10px;text-align:center;pointer-events:none;}',
      '.qwpoke-packleftcol .qwpoke-packbtn{width:100%;}',
      '.qwpoke-packleftcol .qwpoke-packbtn:disabled{width:100%;}',
      '.qwpoke-packmeta{font-size:11px;color:var(--qwp-sub);text-align:center;line-height:1.6;}',
      '.qwpoke-packlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));',
      '  gap:8px;max-height:340px;overflow-y:auto;padding-right:4px;}',
      '.qwpoke-packlist .qwpoke-cell{aspect-ratio:5/7;border-radius:8px;overflow:hidden;padding:0;}',
      '.qwpoke-packlist .qwpoke-cell img{width:100%;height:100%;object-fit:cover;display:block;}',
      /* 有的卡是彩色的，没抽到的降一点亮度即可，用户依然能一眼看出是哪张 */
      '.qwpoke-packlist .qwpoke-cell.uncollected img{filter:brightness(.55) saturate(.5);}',
      '.qwpoke-packlist .qwpoke-cell .qwpoke-cardtag{position:absolute;left:2px;top:2px;padding:0;background:none;color:#fff;',
      '  text-shadow:0 1px 3px rgba(0,0,0,.9);font-size:9px;line-height:1.3;pointer-events:none;}',
      '.qwpoke-packlist-empty{color:var(--qwp-sub);font-size:12px;padding:20px;text-align:center;}',
      /* "查看全部 X 张"：出现在稀有预览之后，占一格空位，长得像卡但没有图 */
      '.qwpoke-seeall{aspect-ratio:5/7;border-radius:8px;display:flex;align-items:center;',
      '  justify-content:center;text-align:center;font-size:12px;color:var(--qwp-fg);',
      '  background:var(--qwp-cell2);border:1px dashed var(--qwp-bd);cursor:pointer;',
      '  padding:6px;line-height:1.4;}',
      '.qwpoke-seeall:hover{background:var(--qwp-hover);}',
      /* 全卡列表 modal：跟灯箱共用暗底，中间放一块 rounded 面板承载卡片网格 */
      '.qwpoke-cardsmodal .qwpoke-cardswrap{width:min(90vw,880px);max-height:82vh;',
      '  background:var(--qwp-bg);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;',
      '  box-shadow:0 30px 80px rgba(0,0,0,.55);}',
      '.qwpoke-cardshead{display:flex;align-items:center;justify-content:space-between;',
      '  padding:12px 16px;border-bottom:1px solid var(--qwp-line);font-weight:600;color:var(--qwp-fg);}',
      '.qwpoke-cardsclose{background:transparent;border:none;font-size:16px;cursor:pointer;',
      '  color:var(--qwp-fg2);}',
      '.qwpoke-cardsgrid{padding:14px;overflow-y:auto;display:grid;',
      '  grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;}',
      '.qwpoke-cardscell{position:relative;aspect-ratio:5/7;border-radius:8px;overflow:hidden;',
      '  background:var(--qwp-cell);cursor:pointer;}',
      '.qwpoke-cardscell img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.qwpoke-cardscell.uncollected img{filter:brightness(.55) saturate(.5);}',
      '.qwpoke-cardscell .qwpoke-cardtag{position:absolute;left:3px;top:3px;padding:0;background:none;',
      '  color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);font-size:9px;line-height:1.3;pointer-events:none;}',
      '.qwpoke-packleft{position:absolute;left:4px;top:4px;padding:1px 5px;border-radius:6px;',
      '  background:rgba(0,0,0,.62);color:#9fe8a0;font-size:9px;line-height:1.6;pointer-events:none;}',
      /* 中文版尚未发行的扩充包在右上角挂一个显眼角标，让用户抽之前就看到 */
      '.qwpoke-packenonly{position:absolute;right:4px;top:4px;padding:1px 5px;border-radius:6px;',
      '  background:#c04a2c;color:#fff;font-size:9px;line-height:1.6;pointer-events:none;',
      '  font-weight:600;}',
      '.qwpoke-cardsrc{position:absolute;right:4px;bottom:16px;padding:1px 5px;border-radius:6px;',
      '  background:rgba(0,0,0,.55);color:#cfd6ea;font-size:9px;line-height:1.6;pointer-events:none;}',
      /* 灯箱：点卡放大看清 */
      '.qwpoke-light{position:fixed;inset:0;z-index:2147483250;display:flex;flex-direction:column;',
      '  align-items:center;justify-content:center;gap:14px;background:rgba(6,8,14,.92);}',
      '.qwpoke-light img{max-width:min(76vw,520px);max-height:74vh;object-fit:contain;border-radius:14px;',
      '  box-shadow:0 20px 60px rgba(0,0,0,.6);}',
      '.qwpoke-lightmeta{color:#e9e9ef;font-size:13px;text-align:center;line-height:1.7;}',
      '.qwpoke-lightbtns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.qwpoke-lightbtns button{padding:7px 15px;border:none;border-radius:9px;cursor:pointer;font-size:12px;',
      '  background:rgba(255,255,255,.14);color:#fff;}',
      '.qwpoke-lightbtns button.primary{background:#f0a020;color:#3a2400;font-weight:600;}',
      '.qwpoke-packbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 10px;}',
      '.qwpoke-packbtn{padding:7px 14px;border:none;border-radius:9px;cursor:pointer;font-size:13px;',
      '  font-weight:600;background:#f0a020;color:#3a2400;}',
      '.qwpoke-packbtn:disabled{background:var(--qwp-chip);color:var(--qwp-sub);cursor:default;font-weight:400;}',
      '.qwpoke-drawn{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px;}',
      '.qwpoke-drawn div{width:74px;text-align:center;font-size:10px;color:var(--qwp-fg2);}',
      '.qwpoke-drawn img{width:74px;height:74px;object-fit:contain;border-radius:7px;',
      '  background:var(--qwp-cell);animation:qwpoke-pop .45s ease-out;}',
      '@keyframes qwpoke-pop{0%{transform:scale(.6);opacity:0;}100%{transform:scale(1);opacity:1;}}',
      '.qwpoke-pet .qwpoke-readytag{position:absolute;left:50%;bottom:-19px;transform:translateX(-50%);',
      '  font:11px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#ffcf33;',
      '  text-shadow:0 0 6px rgba(255,200,0,.85),0 1px 3px rgba(0,0,0,.55);white-space:nowrap;',
      '  pointer-events:none;z-index:6;animation:qwpoke-goldtag 2s ease-in-out infinite;}',
      '@keyframes qwpoke-goldtag{0%,100%{opacity:.78;}50%{opacity:1;}}',
      /* Type attribute badges — two coloured dots at the bottom-left of each pet */
      /* 登场人物: a still portrait that stands with the team, never walks */
      '.qwpoke-trainer{position:fixed;z-index:2147483002;pointer-events:auto;user-select:none;',
      '  image-rendering:auto;transition:opacity .3s;}',
      '.qwpoke-trainer img{display:block;width:100%;height:100%;object-fit:contain;',
      '  filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));}',
      '.qwpoke-trainer.retro img{image-rendering:pixelated;}',
      '.qwpoke-trainer .qwpoke-tname{position:absolute;left:50%;bottom:-17px;transform:translateX(-50%);',
      '  font-size:10px;color:var(--qwp-fg2,#ddd);white-space:nowrap;opacity:0;transition:opacity .2s;',
      '  text-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:none;}',
      '.qwpoke-trainer:hover .qwpoke-tname{opacity:1;}',
      '.qwpoke-pet .qwpoke-types{position:absolute;left:50%;bottom:-16px;transform:translateX(-50%);display:flex;gap:2px;',
      '  pointer-events:auto;z-index:5;opacity:0;transition:opacity .2s;white-space:nowrap;}',
      '.qwpoke-pet:hover .qwpoke-types{opacity:1;}',
      '.qwpoke-pet .qwpoke-type{width:auto;padding:0 4px;border-radius:5px;font-size:9px;color:#fff;',
      '  border:1px solid rgba(255,255,255,.6);line-height:14px;text-align:center;',
      '  text-shadow:0 0 2px rgba(0,0,0,.6);}',
      /* "peek" mode: while feeding from the picker, get the overlay out of the way
         (no dim, no blur) and lift the pets above it so the eating is visible. */
      '#' + IDS.picker + '.qwpoke-peek{background:transparent !important;',
      '  backdrop-filter:none !important;-webkit-backdrop-filter:none !important;',
      '  pointer-events:none;}',
      '#' + IDS.picker + '.qwpoke-peek .qwpoke-panel{opacity:.10;transition:opacity .25s;}',
      '#' + IDS.layer + '.qwpoke-lift{z-index:2147483003;}',
      /* particle layer sits behind the sprite but above the board */
      '.qwpoke-pet .qwpoke-fx{position:absolute;inset:-40%;pointer-events:none;z-index:1;overflow:visible;}',
      '.qwpoke-fx img{position:absolute;will-change:transform,opacity;-webkit-user-drag:none;}',
      /* avatar takeover: hide the app's own glyph, paint ours on top */
      '.qwpoke-avatar-host > *:not(.qwpoke-avatar){opacity:0 !important;}',
      '.qwpoke-avatar{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;',
      '  object-fit:cover;pointer-events:none;}',
      /* picker thumbnails are also big art shown small — ask for the sharper filter */
      '.qwpoke-grid.avatar img{image-rendering:-webkit-optimize-contrast;}',
      /* launcher */
      '#' + IDS.btn + '{position:fixed;right:14px;bottom:14px;z-index:2147483001;width:36px;height:36px;',
      '  border-radius:50%;border:none;cursor:pointer;padding:0;background:transparent;',
      '  transition:transform .18s;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));}',
      '#' + IDS.btn + ' img{width:100%;height:100%;display:block;-webkit-user-drag:none;}',
      '#' + IDS.btn + ':hover{transform:scale(1.14) rotate(-12deg);}',
      /* picker — non-modal on purpose: it can stay open while you click the pets
         underneath, so feeding no longer means closing settings first. The
         overlay only hosts the panel; it neither dims nor swallows clicks. */
      '#' + IDS.picker + '{position:fixed;inset:0;z-index:2147483002;background:transparent;',
      '  pointer-events:none;font:13px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
      '.qwpoke-panel{position:absolute;pointer-events:auto;',
      '  width:min(880px,92vw);height:min(560px,72vh);background:var(--qwp-bg);color:var(--qwp-fg);',
      '  border:1px solid var(--qwp-bd);',
      '  border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;}',
      '.qwpoke-panel.qwpoke-moving{user-select:none;}',
      '.qwpoke-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--qwp-line);',
      '  cursor:move;}',
      '.qwpoke-head button,.qwpoke-head input{cursor:auto;}',
      '.qwpoke-head .qwpoke-tab,.qwpoke-head .qwpoke-x{cursor:pointer;}',
      '.qwpoke-head b{font-size:14px;color:var(--qwp-fg);}',
      '.qwpoke-head .qwpoke-ball{width:20px;height:20px;}',
      '.qwpoke-tabs{display:flex;gap:4px;margin-left:6px;}',
      '.qwpoke-tab{padding:5px 12px;border-radius:8px;cursor:pointer;border:none;background:var(--qwp-chip);font-size:12px;color:var(--qwp-chip-fg);}',
      '.qwpoke-tab.on{background:var(--qwp-acc);color:var(--qwp-acc-fg);}',
      '.qwpoke-x{margin-left:auto;border:none;background:var(--qwp-chip);width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:15px;color:var(--qwp-fg2);}',
      '.qwpoke-search{flex:1;max-width:260px;padding:5px 9px;border:1px solid var(--qwp-bd);border-radius:8px;',
      '  font-size:12px;outline:none;background:var(--qwp-bg);color:var(--qwp-fg);}',
      '.qwpoke-search::placeholder{color:var(--qwp-sub);}',
      /* Filter dropdown: header button + panel of checkbox groups */
      '.qwpoke-filter{position:relative;}',
      '.qwpoke-filter>button{padding:5px 10px;border:1px solid var(--qwp-bd);border-radius:8px;',
      '  background:var(--qwp-chip);color:var(--qwp-chip-fg);font-size:12px;cursor:pointer;white-space:nowrap;}',
      '.qwpoke-filter>button.on{background:#4a90d9;color:#fff;border-color:transparent;}',
      '.qwpoke-fpanel{position:absolute;right:0;top:calc(100% + 6px);z-index:30;width:330px;max-height:58vh;',
      '  overflow:auto;padding:10px 12px;border:1px solid var(--qwp-bd);border-radius:10px;',
      '  background:var(--qwp-bg);box-shadow:0 10px 30px rgba(0,0,0,.28);}',
      '.qwpoke-fgroup{margin-bottom:10px;}',
      '.qwpoke-fgroup>div:first-child{font-size:11px;color:var(--qwp-sub);margin-bottom:5px;}',
      '.qwpoke-fchips{display:flex;flex-wrap:wrap;gap:4px;}',
      '.qwpoke-fchip{padding:3px 8px;border-radius:12px;border:1px solid var(--qwp-bd);cursor:pointer;',
      '  font-size:11px;background:var(--qwp-chip);color:var(--qwp-chip-fg);user-select:none;}',
      '.qwpoke-fchip.on{color:#fff;border-color:transparent;font-weight:600;}',
      '.qwpoke-fclear{width:100%;padding:5px;border:1px solid var(--qwp-bd);border-radius:7px;',
      '  background:var(--qwp-chip);color:var(--qwp-fg2);font-size:11px;cursor:pointer;}',
      '.qwpoke-body{flex:1;overflow:auto;padding:12px 14px;}',
      '.qwpoke-sect{font-size:11px;color:var(--qwp-sub);margin:2px 0 8px;}',
      '.qwpoke-grid{display:grid;gap:10px;}',
      '.qwpoke-grid.bg{grid-template-columns:repeat(auto-fill,minmax(132px,1fr));}',
      '.qwpoke-grid.poke{grid-template-columns:repeat(auto-fill,minmax(84px,1fr));}',
      '.qwpoke-grid.food{grid-template-columns:repeat(auto-fill,minmax(96px,1fr));}',
      '.qwpoke-grid.team{grid-template-columns:repeat(auto-fill,minmax(84px,1fr));margin-bottom:14px;}',
      '.qwpoke-cell{border:2px solid transparent;border-radius:10px;overflow:hidden;cursor:pointer;',
      '  background:var(--qwp-cell);position:relative;transition:border-color .15s, transform .15s;}',
      '.qwpoke-cell:hover{transform:translateY(-2px);}',
      '.qwpoke-cell.on{border-color:var(--qwp-acc);}',
      '.qwpoke-cell img{display:block;width:100%;background:var(--qwp-cell2);}',
      '.qwpoke-cell.bg img{height:92px;object-fit:cover;}',
      '.qwpoke-cell.poke img,.qwpoke-cell.team img{height:70px;object-fit:contain;image-rendering:pixelated;padding:4px;background:var(--qwp-cell);}',
      '.qwpoke-cell.food img{height:56px;object-fit:contain;image-rendering:pixelated;padding:8px;background:var(--qwp-cell);}',
      '.qwpoke-cell .qwpoke-rm{position:absolute;right:3px;top:3px;width:17px;height:17px;border-radius:50%;',
      '  background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:17px;text-align:center;}',
      '.qwpoke-cell .qwpoke-ren{position:absolute;left:3px;top:3px;width:17px;height:17px;border-radius:50%;',
      '  background:rgba(0,0,0,.55);color:#fff;font-size:10px;line-height:17px;text-align:center;}',
      '.qwpoke-cell .qwpoke-rm,.qwpoke-cell .qwpoke-ren{opacity:0;transition:opacity .15s;}',
      '.qwpoke-cell:hover .qwpoke-rm,.qwpoke-cell:hover .qwpoke-ren{opacity:1;}',
      '.qwpoke-cap{font-size:11px;color:var(--qwp-fg2);padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}',
      '.qwpoke-row{display:flex;align-items:center;gap:12px;padding:11px 2px;border-bottom:1px solid var(--qwp-line2);}',
      '.qwpoke-row label{width:130px;color:var(--qwp-fg2);font-size:12px;}',
      '.qwpoke-row input[type=range]{flex:1;accent-color:var(--qwp-acc);}',
      '.qwpoke-row .val{width:46px;text-align:right;color:var(--qwp-sub);font-size:12px;}',
      '.qwpoke-seg{display:flex;gap:5px;}',
      '.qwpoke-seg button{padding:5px 12px;border-radius:7px;border:1px solid var(--qwp-bd);background:var(--qwp-bg);cursor:pointer;font-size:12px;color:var(--qwp-fg2);}',
      '.qwpoke-seg button.on{background:var(--qwp-acc);border-color:var(--qwp-acc);color:var(--qwp-acc-fg);}',
      '.qwpoke-sw{width:42px;height:23px;border-radius:12px;border:none;cursor:pointer;position:relative;background:var(--qwp-sw);transition:background .2s;}',
      '.qwpoke-sw.on{background:var(--qwp-acc);}',
      '.qwpoke-sw i{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .2s;}',
      '.qwpoke-sw.on i{transform:translateX(19px);}',
      '.qwpoke-btn2{padding:6px 13px;border-radius:8px;border:1px solid var(--qwp-bd);background:var(--qwp-bg);cursor:pointer;font-size:12px;color:var(--qwp-chip-fg);}',
      '.qwpoke-btn2:hover{background:var(--qwp-hover);}',
      '.qwpoke-hintbar{padding:8px 14px;border-top:1px solid var(--qwp-line);color:var(--qwp-sub);font-size:11px;}',
      '.qwpoke-hits{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0 4px;}',
      '.qwpoke-hit{padding:4px 10px;border-radius:20px;border:1px solid var(--qwp-bd);background:var(--qwp-bg);',
      '  cursor:pointer;font-size:11px;color:var(--qwp-fg2);}',
      '.qwpoke-hit.on{background:var(--qwp-acc);border-color:var(--qwp-acc);color:var(--qwp-acc-fg);}',
      '.qwpoke-hit.zero{opacity:.4;cursor:default;}',
      /* text prompt: the host renderer refuses window.prompt(), so renaming
         needs its own little dialog. Sits above the picker. */
      '.qwpoke-ask{position:fixed;inset:0;z-index:2147483004;background:var(--qwp-scrim);',
      '  display:flex;align-items:center;justify-content:center;',
      '  font:13px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
      '.qwpoke-askbox{width:min(340px,86vw);background:var(--qwp-bg);color:var(--qwp-fg);',
      '  border-radius:12px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);}',
      '.qwpoke-asktitle{font-size:13px;margin-bottom:10px;color:var(--qwp-fg);}',
      '.qwpoke-askinput{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--qwp-bd);',
      '  border-radius:8px;font-size:13px;outline:none;background:var(--qwp-bg);color:var(--qwp-fg);}',
      '.qwpoke-askinput:focus{border-color:var(--qwp-acc);}',
      '.qwpoke-askrow{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}',
      '.qwpoke-btn2.qwpoke-primary{background:var(--qwp-acc);border-color:var(--qwp-acc);color:var(--qwp-acc-fg);}',
      '.qwpoke-btn2.qwpoke-primary:hover{background:var(--qwp-acc);}',
      /* per-pet chooser: a plain click asks what to do instead of assuming 喂食 */
      '.qwpoke-pop{position:fixed;z-index:2147483005;min-width:126px;padding:4px;',
      '  background:var(--qwp-bg);border:1px solid var(--qwp-bd);border-radius:10px;',
      '  box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:2px;',
      '  font:12px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
      '.qwpoke-pop button{border:none;background:transparent;color:var(--qwp-fg);text-align:left;',
      '  padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12px;white-space:nowrap;}',
      '.qwpoke-pop button:hover{background:var(--qwp-hover);}',
      '.qwpoke-pop .qwpoke-poptitle{color:var(--qwp-sub);font-size:11px;padding:3px 10px 1px;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---------- background board ----------
  function scopeRect(scope) {
    if (scope === 'sidebar') {
      var sb = document.querySelector('.agents-layout-body > div:first-child');
      if (sb) return sb.getBoundingClientRect();
    } else if (scope === 'content') {
      var ca = document.querySelector('.agents-content-area');
      if (ca) return ca.getBoundingClientRect();
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function applyBg() {
    var el = document.getElementById(IDS.bg);
    var root = document.documentElement;
    if (!S.bgFile) {
      if (el) el.remove();
      root.classList.remove('qwpoke-board');
      root.style.removeProperty('--qwpoke-veil');
      root.style.removeProperty('--qwpoke-panel');
      untagSurfaces();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = IDS.bg;
      if (document.body.firstChild) document.body.insertBefore(el, document.body.firstChild);
      else document.body.appendChild(el);
    }
    var r = scopeRect(S.bgScope);
    el.style.left = Math.round(r.left) + 'px';
    el.style.top = Math.round(r.top) + 'px';
    el.style.width = Math.round(r.width) + 'px';
    el.style.height = Math.round(r.height) + 'px';
    el.style.backgroundImage = 'url("' + assetUrl(S.bgFile) + '")';
    /* A card is a 5:7 portrait: `cover` would crop most of it away and tiling would
       shred the artwork, which defeats the point of putting a card you collected on
       the wall. So a card-sourced board switches to `contain` — whole card, centred —
       and the leftover width gets a blurred blow-up of the same card instead of two
       empty bands, which read as a rendering failure rather than a design. */
    var fitContain = (S.bgFit === 'contain') || /\/cards\//.test(String(S.bgFile || ''));
    var blur = el.querySelector('.qwpoke-bgblur');
    var card = el.querySelector('.qwpoke-bgcard');
    if (fitContain) {
      el.style.backgroundImage = 'none';
      if (!blur) {
        blur = document.createElement('div');
        blur.className = 'qwpoke-bgblur';
        el.appendChild(blur);
      }
      if (!card) {
        card = document.createElement('div');
        card.className = 'qwpoke-bgcard';
        el.appendChild(card);
      }
      var u = 'url("' + assetUrl(S.bgFile) + '")';
      blur.style.backgroundImage = u;
      card.style.backgroundImage = u;
    } else {
      if (blur) blur.remove();
      if (card) card.remove();
      el.style.backgroundSize = 'cover';
    }
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = 'center center';
    el.style.opacity = String(bgOpacityNow());
    /* The board is toned toward the theme's own end of the scale before anything
       else: dimmed under a dark theme, washed out under a light one. Regions the
       app paints no surface on (sidebar, gaps between cards) only get the thin
       veil, and text of either polarity over bright board art is unreadable. */
    var fx = [];
    if (S.bgBlur) fx.push('blur(' + S.bgBlur + 'px)');
    /* 只做「够用」的提亮 / 压暗——原来的 1.22 / 0.5 太狠，把插画冲成灰白。
       真正保护文字的是下面的 veil 与 panelAlpha，不是把背景板洗掉。 */
    /* 亮色主题不再动原图明度（brightness 1）——插画本来的层次和色彩就是想看的东西；
       暗色主题仍需压暗，否则浅色文字压在亮插画上会读不了，但只压到还能看出原色的程度。
       文字可读性由下面的 veil 与 panelAlpha 负责，不靠冲淡背景板实现。 */
    fx.push(themeIsDark ? 'brightness(0.78)' : 'brightness(1)');
    fx.push('saturate(' + bgVividNow() + ')');
    el.style.filter = fx.join(' ');
    root.classList.add('qwpoke-board');
    var pa = panelAlphaNow();
    root.style.setProperty('--qwpoke-panel', String(pa));
    /* The veil is all that covers bare regions, so it needs a readable floor.
     *
     * The floor must not out-vote a deliberately low panelAlpha, though: it used
     * to be a flat 0.55 on light themes, so dragging the panel slider down to
     * 0.32 still left a 0.55 sheet of white over the whole window and the board
     * looked barely applied — the slider appeared to do nothing past its middle.
     * Tie the floor to the panel value instead: it stays conservative at default
     * densities and gets out of the way when the user explicitly asks for a
     * bolder board. Bare regions are still covered, just more faintly. */
    var floor = themeIsDark ? Math.min(0.6, pa) : Math.min(0.55, pa);
    var veil = Math.max(pa - 0.2, floor);
    root.style.setProperty('--qwpoke-veil', String(veil));
    tagSurfaces();
  }

  /**
   * Sprite URL for a team slot.
   *
   * Shiny variants aren't bundled with the local gifs, so they come from the
   * Showdown sprite CDN. Custom pets and any pokemon without a known slug fall
   * back to the local file.
   */
  function spriteUrl(id, localFile) {
    /* 性别改成纯元数据：菜单/气泡里保留 ♀/♂ 标记，图形保持不变。
     * 原因：Showdown 的 ani/ 是 Gen-6 精灵（60×60，站立），PokeAPI 提供的
     * generation-v/black-white/animated/female/ 却是 Gen-5 精灵（50×46，跳跃
     * 姿势）——一切性别就切换代际画风，看起来是「整个素材换了」，跟用户
     * 「性别差异应该只是部分身体部位变化或者颜色变化」的直觉完全冲突。
     * 找不到成对匹配的素材，宁可不换：这样至少保持一致性，不至于误导。
     * shiny 变种是 Showdown 有对应 gen-6 精灵的合法切换，故保留。 */
    if (S.shiny && /^\d{4}$/.test(id) && SLUGS[id]) {
      return 'https://play.pokemonshowdown.com/sprites/ani-shiny/' + SLUGS[id] + '.gif';
    }
    /*
     * Three art styles share this resolver:
     *   pixel   — animated gifs, the default and the only style that moves
     *   home    — Pokemon HOME renders, 512px stills
     *   artwork — official Sugimori-style artwork, 630px stills
     * The HD sets are optional downloads sitting beside gif/, so a style that
     * has not been fetched yet falls back to pixel instead of showing a broken
     * image. Photo pets keep their own sprite either way.
     */
    var style = S.spriteStyle || 'pixel';
    /* Mega forms live in the same HD directories under their own id, so let them
       through as well; a form the HD set does not carry falls back to the pixel
       gif through sprite.onerror. */
    if (style !== 'pixel' && (/^\d{4}$/.test(id) || FORMS[id]) && HD_STYLES[style]) {
      // through assetUrl, not SCHEME + path: a ws host has no file URL scheme and
      // needs this to travel over the socket like every other asset
      return assetUrl(PET_HOME + '/' + style + '/' + id + '.png');
    }
    return assetUrl(localFile);
  }

  /** Nickname wins over the official name when the user set one. */
  function labelOf(id) {
    if (S.nicknames && S.nicknames[id]) return S.nicknames[id];
    return nameOf(id);
  }


  // ---------- find whatever is actually covering the board ----------
  /**
   * Different routes paint their opaque surface on different nodes (the chat view
   * uses .agents-chat-panel, 新任务/扩展 use .agents-parchment-paper-surface, the
   * 技能 page paints .agents-content-area itself). Chasing class names is a losing
   * game across releases, so instead we sample a grid of points and look at what
   * is genuinely on top there — cheap, layout-agnostic and theme-aware.
   */
  var taggedSurfaces = [];

  function colorAlpha(col) {
    var m = /\/\s*([\d.]+)\s*\)/.exec(col);          // oklab(... / .4)
    if (m) return parseFloat(m[1]);
    var n = /rgba?\(([^)]+)\)/.exec(col);
    if (n) {
      var parts = n[1].split(',');
      if (parts.length >= 4) return parseFloat(parts[3]);
      return 1;
    }
    return col && col !== 'transparent' ? 1 : 0;
  }

  function colorIsDark(col) {
    if (/^okla?b?\(|^oklch\(/.test(col)) {
      var l = parseFloat(col.replace(/^[a-z]+\(/, ''));
      return isFinite(l) ? l < 0.5 : false;
    }
    var n = /rgba?\(([^)]+)\)/.exec(col);
    if (!n) return false;
    var p = n[1].split(',').map(parseFloat);
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) < 128;
  }

  // ---------- theme (light / dark) ----------
  /**
   * The host publishes its theme as data-theme on <html> ("dark-glass",
   * "light-paper", …). Both the board tint and the picker palette must follow it:
   * whitening a dark theme leaves its near-white text on a near-white surface,
   * which is exactly the "can't read anything" symptom. If the attribute is
   * missing or unfamiliar, fall back to the app's own text colour — light text
   * means a dark theme.
   */
  function isDarkTheme() {
    var t = (document.documentElement.getAttribute('data-theme') || '').toLowerCase();
    if (/dark|night|black|dim/.test(t)) return true;
    if (/light|day|paper|white/.test(t)) return false;
    var col = document.body ? getComputedStyle(document.body).color : '';
    return col ? !colorIsDark(col) : false;
  }

  var themeIsDark = null;

  /** Returns true when the theme actually flipped, so callers can re-sample. */
  function applyTheme() {
    var dark = isDarkTheme();
    if (dark === themeIsDark) return false;
    themeIsDark = dark;
    var root = document.documentElement;
    root.classList.toggle('qwpoke-dark', dark);
    root.style.setProperty('--qwpoke-surface', dark ? '22,24,30' : '255,255,255');
    root.style.setProperty('--qwpoke-veil-rgb', dark ? '12,14,18' : '255,255,255');
    return true;
  }

  function untagSurfaces() {
    taggedSurfaces.forEach(function (el) {
      el.classList.remove('qwpoke-surface-base', 'qwpoke-surface-light', 'qwpoke-surface-dark');
    });
    taggedSurfaces = [];
  }

  function tagSurfaces() {
    untagSurfaces();
    if (!S.bgFile) return;
    var VW = window.innerWidth, VH = window.innerHeight;
    var pts = [];
    [0.16, 0.5, 0.84].forEach(function (fx) {
      [0.2, 0.5, 0.8].forEach(function (fy) {
        pts.push([Math.round(VW * fx), Math.round(VH * fy)]);
      });
    });
    var minArea = VW * VH * 0.12;
    pts.forEach(function (pt) {
      var stack = document.elementsFromPoint(pt[0], pt[1]) || [];
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (!el || !el.classList) continue;
        if (el === document.body || el === document.documentElement) break;
        if (el.id && el.id.indexOf('qwpoke-') === 0) continue;
        if (el.closest && el.closest('#' + IDS.picker)) continue;
        if (el.className && String(el.className).indexOf('qwpoke-') >= 0) continue;
        var col = getComputedStyle(el).backgroundColor;
        if (colorAlpha(col) < 0.85) continue;
        var r = el.getBoundingClientRect();
        if (r.width * r.height < minArea) continue;
        if (taggedSurfaces.indexOf(el) === -1) {
          var isBaseSurface = r.width >= VW * 0.9 && r.height >= VH * 0.9;
          el.classList.add(isBaseSurface ? 'qwpoke-surface-base' : (colorIsDark(col) ? 'qwpoke-surface-dark' : 'qwpoke-surface-light'));
          taggedSurfaces.push(el);
        }
        break;   // only the topmost opaque surface at this sample point
      }
    });
  }

  // ---------- custom pets: cutout polish + pixelation, all on canvas ----------
  /**
   * Everything here runs in the renderer on purpose.
   *
   * The alternative was a Python + Pillow pipeline, but Pillow is not part of any
   * stock macOS or Windows install, so a published skill cannot rely on it.
   * Chromium's canvas is always there, so the sprite is built in-page and only
   * the finished PNG is handed back to the daemon.
   */

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('image load failed')); };
      im.src = url;
    });
  }

  /**
   * Background strip for when no native cutout was available.
   * Flood-fills inward from the edges, so only background connected to the border
   * is removed and same-coloured pixels inside the subject survive.
   */
  function floodFillTransparent(ctx, w, h) {
    var d = ctx.getImageData(0, 0, w, h);
    var px = d.data;
    var seen = new Uint8Array(w * h);
    var stack = [];
    var at = function (x, y) { return (y * w + x) * 4; };

    // Sample the corners to learn what "background" looks like here.
    var samples = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    var br = 0, bg = 0, bb = 0;
    samples.forEach(function (i) { br += px[i]; bg += px[i + 1]; bb += px[i + 2]; });
    br /= 4; bg /= 4; bb /= 4;
    var TOL = 42;

    var isBg = function (i) {
      if (px[i + 3] < 24) return true;
      return Math.abs(px[i] - br) < TOL && Math.abs(px[i + 1] - bg) < TOL && Math.abs(px[i + 2] - bb) < TOL;
    };

    for (var x = 0; x < w; x++) { stack.push(x, 0); stack.push(x, h - 1); }
    for (var y = 0; y < h; y++) { stack.push(0, y); stack.push(w - 1, y); }

    while (stack.length) {
      var cy = stack.pop(), cx = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      var idx = cy * w + cx;
      if (seen[idx]) continue;
      var i4 = idx * 4;
      if (!isBg(i4)) continue;
      seen[idx] = 1;
      px[i4 + 3] = 0;
      stack.push(cx + 1, cy); stack.push(cx - 1, cy);
      stack.push(cx, cy + 1); stack.push(cx, cy - 1);
    }
    ctx.putImageData(d, 0, 0);
  }

  /** Crop to the visible subject. */
  function alphaBBox(ctx, w, h) {
    var px = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { x: 0, y: 0, w: w, h: h };
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /**
   * Photo -> pokemon-style sprite.
   *
   * Downscaling to sprite resolution is also what hides the last few imperfect
   * pixels along a fur edge, which is where every cutout is weakest. Alpha is
   * hardened afterwards so no grey halo survives over a background board, and a
   * 1px dark outline makes the sprite read on light and dark backgrounds alike.
   */
  function makeSprite(img, opts) {
    opts = opts || {};
    var target = opts.size || 64;
    var doFill = !!opts.floodFill;
    var outline = opts.outline !== false;

    // full-resolution pass (cap it so huge photos stay cheap)
    var maxSide = 1400;
    var s0 = Math.min(1, maxSide / Math.max(img.width, img.height));
    var w0 = Math.max(1, Math.round(img.width * s0));
    var h0 = Math.max(1, Math.round(img.height * s0));
    var c0 = document.createElement('canvas');
    c0.width = w0; c0.height = h0;
    var x0 = c0.getContext('2d', { willReadFrequently: true });
    x0.drawImage(img, 0, 0, w0, h0);
    if (doFill) floodFillTransparent(x0, w0, h0);

    var box = alphaBBox(x0, w0, h0);

    // downscale the cropped subject to sprite resolution
    var s1 = target / Math.max(box.w, box.h);
    var w1 = Math.max(1, Math.round(box.w * s1));
    var h1 = Math.max(1, Math.round(box.h * s1));
    var c1 = document.createElement('canvas');
    c1.width = w1; c1.height = h1;
    var x1 = c1.getContext('2d', { willReadFrequently: true });
    x1.imageSmoothingEnabled = true;
    x1.imageSmoothingQuality = 'high';
    x1.drawImage(c0, box.x, box.y, box.w, box.h, 0, 0, w1, h1);

    // harden alpha: partial pixels become fully on/off
    var d1 = x1.getImageData(0, 0, w1, h1);
    var p1 = d1.data;
    for (var i = 0; i < p1.length; i += 4) {
      var a = p1[i + 3];
      p1[i + 3] = a < 96 ? 0 : (a > 150 ? 255 : a);
    }
    x1.putImageData(d1, 0, 0);

    if (!outline) return c1.toDataURL('image/png');

    // 1px dark border around the silhouette
    var c2 = document.createElement('canvas');
    c2.width = w1 + 2; c2.height = h1 + 2;
    var x2 = c2.getContext('2d', { willReadFrequently: true });
    var alpha = x1.getImageData(0, 0, w1, h1).data;
    var solid = function (x, y) {
      if (x < 0 || y < 0 || x >= w1 || y >= h1) return false;
      return alpha[(y * w1 + x) * 4 + 3] > 8;
    };
    var out = x2.createImageData(c2.width, c2.height);
    var op = out.data;
    for (var y2 = 0; y2 < c2.height; y2++) {
      for (var x2i = 0; x2i < c2.width; x2i++) {
        var sx = x2i - 1, sy = y2 - 1;
        if (solid(sx, sy)) continue;
        var near = solid(sx - 1, sy) || solid(sx + 1, sy) || solid(sx, sy - 1) || solid(sx, sy + 1);
        if (!near) continue;
        var o = (y2 * c2.width + x2i) * 4;
        op[o] = 38; op[o + 1] = 38; op[o + 2] = 46; op[o + 3] = 255;
      }
    }
    x2.putImageData(out, 0, 0);
    x2.drawImage(c1, 1, 1);
    return c2.toDataURL('image/png');
  }

  /** Poll a JSON file that the daemon writes (readable straight over local-file://). */
  function pollJson(pathStr, test, tries, everyMs) {
    var n = 0;
    return new Promise(function (resolve, reject) {
      var tick = function () {
        n++;
        if (n > tries) return reject(new Error('timeout'));
        // ws host: fetch cannot reach local files at all, so pull the bytes over
        // the socket. http host: fetch is CSP-blocked, so the relay iframe reads
        // the file instead. Each request re-reads from disk, so there is no cache
        // to bust.
        var read = (TRANSPORT === 'ws')
          ? wsAssetText(String(pathStr).replace(/\\/g, '/')).then(function (t) {
              if (t === null) throw new Error('unreadable');
              return JSON.parse(t);
            })
          : (TRANSPORT === 'http')
          ? relaySend({ kind: 'text', path: String(pathStr).replace(/\\/g, '/') }).then(function (t) {
              if (t === null) throw new Error('unreadable');
              return JSON.parse(t);
            })
          : fetch(assetUrl(pathStr) + '?t=' + Date.now()).then(function (r) { return r.json(); });
        read
          .then(function (j) {
            if (test(j)) resolve(j);
            else setTimeout(tick, everyMs);
          })
          .catch(function () { setTimeout(tick, everyMs); });
      };
      tick();
    });
  }

  // ---------- avatar takeover ----------
  /**
   * The host's own avatar is a small round div in the bottom-left profile row.
   * We find it by shape + position rather than by class, because utility-class
   * names churn between releases.
   */
  function findAvatarHost() {
    var best = null;
    var nodes = document.querySelectorAll('div.rounded-full, span.rounded-full');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 20 || r.width > 56) continue;
      if (Math.abs(r.width - r.height) > 6) continue;
      // bottom-left corner of the window
      if (r.left > 140 || r.top < window.innerHeight - 160) continue;
      if (!best || r.top > best.rect.top) best = { el: el, rect: r };
    }
    return best ? best.el : null;
  }

  /**
   * Light unsharp mask, in place on a canvas.
   *
   * Every downscale softens edges, and at a 32px avatar slot that reads as
   * "blurry". A small 3x3 sharpen buys back a lot of perceived detail; the
   * amount is kept low so it does not turn into halos on flat colour.
   */
  function sharpen(canvas, amount) {
    try {
      var ctx = canvas.getContext('2d');
      var w = canvas.width, h = canvas.height;
      var src = ctx.getImageData(0, 0, w, h);
      var out = ctx.createImageData(w, h);
      var s = src.data, d = out.data;
      var k = amount;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
            d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = s[i+3];
            continue;
          }
          for (var c = 0; c < 3; c++) {
            var p = i + c;
            var lap = 4 * s[p]
                    - s[p - 4] - s[p + 4]
                    - s[p - w * 4] - s[p + w * 4];
            var v = s[p] + k * lap / 4;
            d[p] = v < 0 ? 0 : v > 255 ? 255 : v;
          }
          d[i+3] = s[i+3];   // keep alpha untouched so the round mask stays clean
        }
      }
      ctx.putImageData(out, 0, 0);
    } catch (e) {}
  }

  /**
   * High-quality downscale via canvas, halving at a time.
   *
   * The avatar art is 256x256 but the host slot is ~32px, and letting the
   * browser do a one-shot 8x reduction throws away most of the detail — faces
   * come out as mush. Successive halving keeps far more of it, and the final
   * step to the exact target uses high-quality smoothing.
   */
  function downscaleDataUrl(img, target) {
    try {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return null;
      var cur = document.createElement('canvas');
      var ctx = cur.getContext('2d');
      cur.width = w; cur.height = h;
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
      // halve until one more halving would go below the target
      while (cur.width / 2 >= target && cur.height / 2 >= target) {
        var next = document.createElement('canvas');
        next.width = Math.max(1, Math.floor(cur.width / 2));
        next.height = Math.max(1, Math.floor(cur.height / 2));
        var nctx = next.getContext('2d');
        nctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in nctx) nctx.imageSmoothingQuality = 'high';
        nctx.drawImage(cur, 0, 0, next.width, next.height);
        cur = next;
      }
      if (cur.width !== target || cur.height !== target) {
        var fin = document.createElement('canvas');
        fin.width = target; fin.height = target;
        var fctx = fin.getContext('2d');
        fctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in fctx) fctx.imageSmoothingQuality = 'high';
        fctx.drawImage(cur, 0, 0, target, target);
        cur = fin;
      }
      sharpen(cur, 0.55);   // any downscale softens edges; win some of it back
      return cur.toDataURL('image/png');
    } catch (e) { return null; }
  }

  function applyAvatar() {
    var host = findAvatarHost();
    if (!host) return;
    var img = host.querySelector('.qwpoke-avatar');
    if (!S.avatarFile) {
      if (img) img.remove();
      host.classList.remove('qwpoke-avatar-host');
      return;
    }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.classList.add('qwpoke-avatar-host');
    if (!img) {
      img = document.createElement('img');
      img.className = 'qwpoke-avatar';
      img.draggable = false;
      host.appendChild(img);
    }
    var url = assetUrl(S.avatarFile);
    if (img.getAttribute('data-src') === url) return;   // already rendered
    img.setAttribute('data-src', url);

    // Render through a canvas at 2x the slot size so the browser only does a
    // gentle final step instead of an 8x one-shot reduction.
    var rect = host.getBoundingClientRect();
    var slot = Math.max(24, Math.round(rect.width || 32));
    var target = Math.min(256, slot * Math.max(2, Math.ceil(window.devicePixelRatio || 1) + 1));
    var probe = new Image();
    probe.onload = function () {
      // a newer pick may have started while this one was loading
      if (img.getAttribute('data-src') !== url || !img.isConnected) return;
      var data = downscaleDataUrl(probe, target);
      img.setAttribute('src', data || url);
    };
    probe.onerror = function () {
      if (img.getAttribute('data-src') !== url || !img.isConnected) return;
      img.setAttribute('src', url);
    };
    probe.src = url;
  }

  // ---------- TCGP particle effects ----------
  /* Which motion suits each shape. Ported from the desktop pet so the same
     shape behaves the same way here. */
  var FX_STYLE = {
    '小星星': 'burst', '線條星星': 'burst', '小愛心': 'rise', '線條愛心': 'rise', '小光點': 'rise',
    '泡泡': 'rise', '音符': 'rise', '花瓣': 'fall', '雪花': 'fall', '飄羽': 'fall', '火焰': 'rise',
    '閃電': 'burst', '爆炸': 'burst', '劍閃': 'burst', '星光': 'burst', '陽光閃亮亮': 'orbit',
    '連繫閃亮亮': 'orbit', '異色閃亮亮': 'orbit', '異色特殊閃亮亮': 'orbit', '小三角': 'burst',
    '小六角': 'burst', '小岩塊': 'fall', '煙塵': 'rise', '四葉草': 'fall', '草本': 'rise',
    '花環': 'orbit', '大圓圈': 'burst', '圓圈圈': 'burst', '圓角矩形': 'burst', '數位矩形': 'burst',
    '光圈': 'orbit', '小圆圈': 'burst', '精靈球': 'burst', '皮卡丘剪影': 'rise', '究極異獸': 'orbit'
  };

  function fxShapes() {
    var seen = {}, out = [];
    for (var i = 0; i < FX_LIST.length; i++) {
      var sh = FX_LIST[i].shape;
      if (!sh || seen[sh]) continue;
      seen[sh] = 1;
      out.push({ shape: sh, file: FX_LIST[i].file, count: 0 });
    }
    for (var j = 0; j < out.length; j++) {
      for (var k = 0; k < FX_LIST.length; k++) if (FX_LIST[k].shape === out[j].shape) out[j].count++;
    }
    return out;
  }

  function fxPick(shape) {
    var pool = [];
    for (var i = 0; i < FX_LIST.length; i++) if (FX_LIST[i].shape === shape) pool.push(FX_LIST[i]);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Spawn one particle around a pet. */
  function fxSpawn(petObj, shape, style) {
    if (!petObj.fx) return;
    var fx = fxPick(shape);
    if (!fx) return;
    var st = style || FX_STYLE[shape] || 'rise';
    var el = document.createElement('img');
    el.src = assetUrl(fx.file);
    el.draggable = false;
    var sz = 12 + Math.random() * 14;
    el.style.width = sz + 'px';
    el.style.height = sz + 'px';

    var CX = 50, CY = 54;
    var ang = Math.random() * Math.PI * 2;
    var RX = 22 + Math.random() * 8, RY = 20 + Math.random() * 8;
    var sx = CX + Math.cos(ang) * RX, sy = CY + Math.sin(ang) * RY;
    el.style.left = sx + '%';
    el.style.top = sy + '%';
    petObj.fx.appendChild(el);

    var frames, dur = 1200 + Math.random() * 700;
    if (st === 'rise') {
      frames = [
        { opacity: 0, transform: 'translate(-50%,-50%) scale(.4)' },
        { opacity: 1, offset: .25, transform: 'translate(-50%,-50%) translateY(-10px) scale(1) rotate(' + ((Math.random() - .5) * 40) + 'deg)' },
        { opacity: 0, transform: 'translate(-50%,-50%) translateY(-42px) scale(1.05) rotate(' + ((Math.random() - .5) * 80) + 'deg)' }
      ];
    } else if (st === 'fall') {
      frames = [
        { opacity: 0, transform: 'translate(-50%,-50%) translateY(-28px) scale(.5)' },
        { opacity: 1, offset: .25, transform: 'translate(-50%,-50%) scale(1) rotate(90deg)' },
        { opacity: 0, transform: 'translate(-50%,-50%) translateY(36px) scale(.9) rotate(220deg)' }
      ];
      dur += 300;
    } else if (st === 'orbit') {
      var dir = Math.random() < .5 ? 1 : -1;
      var a1 = ang + dir * Math.PI * 1.6;
      frames = [
        { opacity: 0, left: sx + '%', top: sy + '%', transform: 'translate(-50%,-50%) scale(.4)' },
        { opacity: .95, offset: .3, transform: 'translate(-50%,-50%) scale(1.1)' },
        { opacity: .95, offset: .5, left: (CX + Math.cos(ang + (a1 - ang) * .5) * RX) + '%', top: (CY + Math.sin(ang + (a1 - ang) * .5) * RY) + '%' },
        { opacity: 0, left: (CX + Math.cos(a1) * RX) + '%', top: (CY + Math.sin(a1) * RY) + '%', transform: 'translate(-50%,-50%) scale(1.2)' }
      ];
      dur = 1600 + Math.random() * 700;
    } else {
      el.style.left = CX + '%';
      el.style.top = CY + '%';
      var r = 22 + Math.random() * 24;
      var dx = Math.cos(ang) * r, dy = Math.sin(ang) * r;
      frames = [
        { opacity: 0, transform: 'translate(-50%,-50%) translate(0,0) scale(.3)' },
        { opacity: 1, offset: .25, transform: 'translate(-50%,-50%) translate(' + dx * .5 + 'px,' + dy * .5 + 'px) scale(1.1) rotate(60deg)' },
        { opacity: 0, transform: 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(.7) rotate(160deg)' }
      ];
      dur = 850 + Math.random() * 450;
    }
    el.animate(frames, { duration: dur, easing: 'ease-out' });
    setTimeout(function () { el.remove(); }, dur + 60);
  }

  var fxTimer = null;
  function fxTick() {
    if (fxTimer) { clearInterval(fxTimer); fxTimer = null; }
    var shape = S.fxShape;
    if (!shape) {
      PETS.forEach(function (p) { if (p.fx) p.fx.innerHTML = ''; });
      return;
    }
    var st = FX_STYLE[shape] || 'rise';
    var interval = (st === 'burst') ? 900 : 520;
    var spawn = function () {
      var n = (st === 'burst') ? (2 + Math.floor(Math.random() * 2)) : 1;
      PETS.forEach(function (p) {
        for (var k = 0; k < n; k++) setTimeout(function () { fxSpawn(p, shape, st); }, k * 70);
      });
    };
    spawn();
    fxTimer = setInterval(spawn, interval);
  }

  // ---------- Pet ----------
  var PETS = [];

  function Pet(no, index) {
    this.no = no;
    this.index = index;
    this.busy = false;
    this.dragging = false;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.speed = 0.030 + Math.random() * 0.014;   // px per ms
    this.phase = Math.random() * 1000;
    this.x = 0;
    this.y = 0;
    this.el = null;
  }

  Pet.prototype.mount = function (layer) {
    var size = petSizeOf(this.no);
    var el = document.createElement('div');
    el.className = 'qwpoke-pet';
    el.dataset.no = this.no;
    el.style.width = size + 'px';
    el.style.height = size + 'px';

    var tip = document.createElement('div');
    tip.className = 'qwpoke-tip';

    var food = document.createElement('img');
    food.className = 'qwpoke-food';
    food.draggable = false;
    food.style.width = Math.round(size * 0.29) + 'px';
    food.style.height = Math.round(size * 0.29) + 'px';

    var hearts = document.createElement('div');
    hearts.className = 'qwpoke-hearts';

    var fx = document.createElement('div');
    fx.className = 'qwpoke-fx';

    var sprite = document.createElement('img');
    sprite.className = 'qwpoke-sprite';
    sprite.draggable = false;
    var e = entryOf(this.no);
    if (e) {
      // if an HD-style image is missing, fall back once to the pixel gif so the
      // pet is never a broken image (HD sets are complete today, but this makes
      // a switch bulletproof against any single missing file)
      var pixel = assetUrl(e.file);
      sprite.onerror = function () {
        var cur = sprite.getAttribute('src') || '';
        // ws 模式下 placeholder 不是真错误，asset 还在路上
        if (cur.indexOf(ASSET_MARK) === 0) return;
        if (cur !== pixel) sprite.setAttribute('src', pixel);
      };
      sprite.src = spriteUrl(this.no, e.file);
    }

    el.appendChild(tip);
    el.appendChild(fx);
    el.appendChild(food);
    el.appendChild(hearts);
    el.appendChild(sprite);

    // Type attribute badges (bottom-left, 1-2 colored dots that expand to text on hover)
    var td = attrOf(this.no);
    if (td && td.types && td.types.length) {
      var tc = document.createElement('div');
      tc.className = 'qwpoke-types';
      td.types.forEach(function (t) {
        var dot = document.createElement('span');
        dot.className = 'qwpoke-type';
        dot.style.background = TYPE_COLORS[t] || '#888';
        dot.textContent = TYPE_ZH[t] || t;
        dot.title = TYPE_ZH[t] || t;
        tc.appendChild(dot);
      });
      el.appendChild(tc);
    }

    layer.appendChild(el);

    this.el = el; this.sprite = sprite; this.food = food;
    this.hearts = hearts; this.tip = tip; this.fx = fx;

    // where this one starts depends on the placement mode
    var slot = this.index + 1;
    var place = placement();
    if (place === 'free') {
      var saved = S.petPos && S.petPos[this.no];
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        this.x = saved.x; this.y = saved.y;
      } else {
        // never dropped anywhere yet: start on the floor so it is easy to find
        var span0 = Math.max(1, window.innerWidth - size);
        this.x = Math.min(span0, Math.round(span0 * (slot / (S.team.length + 1))));
        this.y = window.innerHeight - size - 6;
      }
    } else if (place === 'right') {
      var saved = S.petPos && S.petPos[this.no];
      var rz = rightZone();
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && saved.x >= rz.left) {
        this.x = saved.x; this.y = saved.y;
      } else {
        // 初次：随机散落在右侧面板范围内
        this.x = rz.left + Math.random() * Math.max(1, rz.width - size);
        this.y = rz.top + Math.random() * Math.max(1, rz.height - size);
      }
    } else {
      var span = Math.max(1, window.innerWidth - size);
      this.x = Math.min(span, Math.round(span * (slot / (S.team.length + 1))));
      this.y = window.innerHeight - size - 6;
    }
    this.clamp();
    this.draw();
    this.bind();
    return this;
  };

  Pet.prototype.unmount = function () {
    if (this.el) this.el.remove();
    this.el = null;
  };

  Pet.prototype.draw = function () {
    if (!this.el) return;
    this.el.style.transform = 'translate(' + Math.round(this.x) + 'px,' + Math.round(this.y) + 'px)';
    if (this.sprite && !this.busy) {
      /* On the right rail the movement is vertical, so flipping on direction would
         make it turn around for no visible reason — keep it facing into the window
         (i.e. left) the whole time instead. */
      var flip = placement() === 'right' ? true : this.dir < 0;
      this.sprite.style.transform = flip ? 'scaleX(-1)' : 'none';
    }
  };

  /** 右侧模式的漫步区域：限定在实际的「右侧任务监控面板」范围内，不侵入中间工作区。
   *  页面里同一个 class 可能出现多次（中间大面板和右侧小面板都叫 workbench-stack-view），
   *  所以用 querySelectorAll + 过滤"宽度 180-420px 且 left > 窗口 55%"来锁定右侧那个。 */
  function rightZone() {
    var w = window.innerWidth;
    var candidates = document.querySelectorAll('.workbench-stack-view, .agents-chat-panel, [class*="right-panel"]');
    for (var i = 0; i < candidates.length; i++) {
      var r = candidates[i].getBoundingClientRect();
      if (r.width >= 180 && r.width <= 420 && r.left > w * 0.55 && r.height > 200) {
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      }
    }
    // fallback：窗口最右侧 320px
    return { left: Math.max(0, w - 320), top: 0, width: 320, height: window.innerHeight };
  }
  Pet.prototype.clamp = function () {
    var size = petSizeOf(this.no);
    this.x = Math.min(Math.max(0, this.x), Math.max(0, window.innerWidth - size));
    this.y = Math.min(Math.max(0, this.y), Math.max(0, window.innerHeight - size));
  };

  Pet.prototype.tick = function (t, dt) {
    if (!this.el || this.dragging || this.busy) return;
    var place = placement();
    if (place === 'free') return;          // stays exactly where it was dropped
    var bob = Math.abs(Math.sin((t + this.phase) / 190)) * 3;
    if (place === 'right') {
      /* "右侧随意走动"：限定在右侧任务监控面板范围内自由漫步，不侵入中间工作区。 */
      var size2 = petSizeOf(this.no);
      var zone = rightZone();
      var zoneLeft = zone.left;
      var zoneRight = Math.max(zoneLeft, zone.left + zone.width - size2);
      var zoneTop = zone.top;
      var zoneBottom = Math.max(zoneTop, zone.top + zone.height - size2);
      if (!this._wp || (Math.abs(this.x - this._wp.x) < 4 && Math.abs(this.y - this._wp.y) < 4)) {
        this._wp = {
          x: zoneLeft + Math.random() * (zoneRight - zoneLeft),
          y: zoneTop + Math.random() * (zoneBottom - zoneTop)
        };
      }
      var dx = this._wp.x - this.x;
      var dy = this._wp.y - this.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var step = this.speed * dt;
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
      this.x = Math.min(Math.max(zoneLeft, this.x), zoneRight);
      this.y = Math.min(Math.max(zoneTop, this.y), zoneBottom);
    } else {
      this.x += this.dir * this.speed * dt;
      var maxX = Math.max(0, window.innerWidth - petSizeOf(this.no));
      if (this.x <= 0) { this.x = 0; this.dir = 1; }
      if (this.x >= maxX) { this.x = maxX; this.dir = -1; }
      this.y = window.innerHeight - petSizeOf(this.no) - 6 - bob;
    }
    this.draw();
  };

  Pet.prototype.showTip = function (text, ms) {
    if (!this.tip || !this.el) return;   // may be called from a late async callback
    var self = this;
    this.tip.textContent = text;
    this.el.classList.add('qwpoke-hint');
    clearTimeout(this._tipT);
    this._tipT = setTimeout(function () {
      if (self.el) self.el.classList.remove('qwpoke-hint');
    }, ms || 1500);
  };

  Pet.prototype.spawnHeart = function () {
    if (!this.hearts) return;
    var h = document.createElement('div');
    h.className = 'qwpoke-heart';
    h.textContent = '\u2764\uFE0E';
    h.style.left = (28 + Math.random() * 44) + '%';
    h.style.bottom = '45%';
    this.hearts.appendChild(h);
    var dur = 850 + Math.random() * 450;
    h.animate(
      [{ opacity: 1, transform: 'translateY(0) scale(.8)' },
       { opacity: 0, transform: 'translateY(-46px) scale(1.25)' }],
      { duration: dur, easing: 'ease-out' }
    );
    setTimeout(function () { h.remove(); }, dur);
  };

  /** Feed this pokemon. `item` may be a food entry; omitted = random pick. */
  Pet.prototype.feed = function (item) {
    if (this.busy || !this.el) return Promise.resolve();
    var self = this;
    if (!item && FOOD_LIST.length) item = FOOD_LIST[Math.floor(Math.random() * FOOD_LIST.length)];
    if (!item) { this.showTip('没有食物素材', 1400); return Promise.resolve(); }
    this.busy = true;
    /*
     * Credit the bond here, not at the end of the animation. The animation can
     * fail to settle (a hidden window suspends the compositor), and losing the
     * reward for a feed the user actually performed is the worse failure.
     */
    var fed = addAffection(this.no);
    // feeding itself earns a pack, capped per day (see FEED_PACKS_PER_DAY)
    var feedPack = grantPackForFeed();

    var sprite = this.sprite, food = this.food;
    var flip = this.dir < 0 ? ' scaleX(-1)' : '';
    food.src = assetUrl(item.file);
    food.style.transform = 'translateX(-50%) scale(0)';
    food.style.opacity = '0';
    void food.offsetHeight;
    food.style.transform = 'translateX(-50%) scale(1)';
    food.style.opacity = '1';

    return sleep(380).then(function () {
      // dip down and chew
      var seq = [];
      for (var k = 0; k < 4; k++) {
        seq.push({ transform: 'translateY(7px) scale(1.06)' + flip });
        seq.push({ transform: 'translateY(2px) scale(1)' + flip });
      }
      seq.push({ transform: 'translateY(0) scale(1)' + flip });
      sprite.animate(seq, { duration: 1040, easing: 'ease-in-out' });
      return sleep(1040);
    }).then(function () {
      food.style.transform = 'translateX(-50%) scale(0)';
      food.style.opacity = '0';
      for (var k = 0; k < 4; k++) setTimeout(function () { self.spawnHeart(); }, k * 110);
      // happy hop
      sprite.animate(
        [{ transform: 'translateY(0)' + flip },
         { transform: 'translateY(-22px)' + flip },
         { transform: 'translateY(0)' + flip },
         { transform: 'translateY(-11px)' + flip },
         { transform: 'translateY(0)' + flip }],
        { duration: 620, easing: 'ease-out' }
      );
      return sleep(660);
    }).then(function () {
      self.busy = false;
      self.draw();
      // the bond was already credited above; this is just the nudge afterwards
      if (fed && fed.gain > 0 && fed.full && (fed.ready || canMega(self.no))) {
        self.showTip('好像要进化了…点我看看', 5200);
      }
    });
  };

  /**
   * What to do with this pet?
   *
   * A plain click used to feed immediately, which gave no way to trigger an
   * action and made feeding happen by accident. Now it opens a small chooser
   * anchored at the click point.
   */
  function closePetPop() {
    var old = document.querySelector('.qwpoke-pop');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    document.removeEventListener('mousedown', onPopOutside, true);
    document.removeEventListener('keydown', onPopKey, true);
  }
  function onPopOutside(ev) {
    var pop = document.querySelector('.qwpoke-pop');
    if (pop && !pop.contains(ev.target)) closePetPop();
  }
  function onPopKey(ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); closePetPop(); }
  }

  /**
   * Run a user-requested animation even if an idle action is mid-flight.
   * feed()/act() bail out while busy, so without this a click could silently do
   * nothing — which is exactly how "点了没反应" happens.
   */
  Pet.prototype.queue = function (fn, waitMs) {
    var self = this;
    var deadline = Date.now() + (waitMs || 3200);
    return new Promise(function (resolve) {
      var tick = function () {
        if (!self.busy || Date.now() > deadline) {
          // waited long enough — the user asked for this, so don't let it fizzle
          if (self.busy) self.busy = false;
          resolve(fn());
          return;
        }
        setTimeout(tick, 80);
      };
      tick();
    });
  };

  function petChooser(petObj, cx, cy) {
    closePetPop();
    var pop = document.createElement('div');
    pop.className = 'qwpoke-pop';

    var title = document.createElement('div');
    title.className = 'qwpoke-poptitle';
    // show the bond here: it is the only place the number is visible, and it is
    // what explains why the pet is glowing
    title.textContent = labelOf(petObj.no) + ' · ' + affectionName(petObj.no) +
      ' ' + affectionOf(petObj.no) + '/' + AFFECTION_MAX;
    pop.appendChild(title);

    /*
     * Guard against the second half of a double-click landing on the menu.
     * The menu is anchored just above the cursor, so a quick second click (or a
     * shaky hand) used to fall straight onto the first row. That row was the
     * evolution offer — reported live as "it suddenly evolved by itself", and the
     * saved bond still carried the mega form to prove it happened.
     * Clicks inside this window are swallowed, not queued.
     */
    /* 420ms covers a typical fast double-click (~150-400ms between presses) while
       still feeling instant to a deliberate single click. */
    var POP_ARM_MS = 420;
    var armedAt = Date.now();
    var add = function (text, fn) {
      var b = document.createElement('button');
      b.textContent = text;
      b.onclick = function (ev) {
        ev.stopPropagation();
        if (Date.now() - armedAt < POP_ARM_MS) return;   // too soon to be deliberate
        closePetPop();
        fn();
      };
      pop.appendChild(b);
    };
    /** A non-clickable divider, so irreversible rows are never the first thing
        under the cursor. */
    var addLabel = function (text) {
      var d = document.createElement('div');
      d.style.cssText = 'padding:5px 10px 3px;font-size:10px;color:var(--qwp-fg2);' +
        'border-top:1px solid var(--qwp-line2);margin-top:3px;';
      d.textContent = text;
      pop.appendChild(d);
    };

    /* Everyday actions first. Evolution used to sit at the top, which put an
       irreversible action directly under a cursor that had just clicked. */
    add('喂食 \uD83C\uDF6C', function () { petObj.queue(function () { return petObj.feed(); }); });
    add('换个动作 \uD83C\uDFAC', function () {
      petObj.queue(function () { return petObj.act(randomAction()); });
    });
    add('挑个道具喂 \uD83C\uDF71', function () { openPicker('food', petObj); });
    if (S.escapeToDesktop && BRIDGE && DESKTOP_READY) {
      add('去桌面 \uD83D\uDDA5', function () { escapeToDesktop(petObj); });
    }

    /* 不变之石：有就在靠前位置提供收回入口 */
    if (hasEverstone(petObj.no)) {
      add('\uD83E\uDEA8 收回不变之石', function () {
        if (S.everstone) delete S.everstone[petObj.no];
        saveSettings(); refreshGlow();
        petObj.showTip('不变之石收回了，现在可以变形了', 3600);
      });
    }

    /* Gender — only where it is a real choice. A genderless species (Magnemite,
       most legendaries) and a fixed-gender one (Nidoqueen) must not be offered a
       switch that means nothing. For the 102 dimorphic species the sprite changes
       with it, for the rest it is just the ♂/♀ mark. */
    if (canChooseGender(petObj.no)) {
      var gNow = genderOf(petObj.no);
      var gWant = gNow === 'f' ? 'm' : 'f';
      // 性别是元数据（只影响名字旁边的 ♀/♂ 标记），不再切换图形——旧版会切
      // 一份代际不同的精灵图，看着像"换宠物"，跟用户直觉不一致。
      add((gNow === 'f' ? '\u2640' : '\u2642') + ' 性别：改成 ' + GENDER_SIGN[gWant], function () {
        setGender(petObj.no, gWant);
        petObj.showTip('现在是 ' + GENDER_SIGN[gWant] + ' 了', 2600);
      });
      /* 官方游戏里雌雄外观差异肉眼可见的物种（沙河马、超能妙喵这类），
         在按钮下方补一行提示，让用户知道"这只在原作里其实长得不一样"，
         同时诚实说明当前实现里图形保持一致——找不到成对匹配的精灵图，
         用一份跨代精灵去凑反而更假。 */
      if (isMajorDimorphic(petObj.no)) {
        addLabel('\u26A0 官方差异：' + majorDimorphicHint(petObj.no));
        addLabel('（此实现里图形保持一致，性别只显示为 \u2642/\u2640 标记）');
      }
    }

    /* Regional forms — Alolan / Galarian / Hisuian / Paldean. Unlike evolution these
       are just a different look of the same species, so switching is free and
       reversible and does not touch affection. */
    var regOpts = regionalOptionsFor(petObj.no);
    if (regOpts.length) {
      addLabel('地区形态');
      regOpts.forEach(function (r) {
        add('\uD83C\uDF0D 变成' + r.zh, function () { switchRegional(petObj.no, r.id); });
      });
    }
    if (REGIONAL_FORMS[petObj.no]) {
      addLabel('地区形态');
      add('\u21A9\uFE0F 变回' + labelOf(REGIONAL_FORMS[petObj.no].base), function () {
        switchRegional(petObj.no, REGIONAL_FORMS[petObj.no].base);
      });
    }

    /* 太晶化 — 只有特定宝可梦有太晶形态，不变之石拦住 */
    var teraFormId = petObj.no + '-tera';
    var teraEntry = TERA_FORMS[teraFormId];
    if (teraEntry && !TERA_FORMS[petObj.no] && !hasEverstone(petObj.no)) {
      // 这只宝可梦有太晶形态可用且没有不变之石
      var tType = teraEntry.teraType || '';
      addLabel('太晶化');
      add('\uD83D\uDC8E 太晶化（' + (TERA_ZH[tType] || tType) + '属性）', function () {
        teraEvolve(petObj.no, teraFormId);
      });
    }
    if (TERA_FORMS[petObj.no] && TERA_FORMS[petObj.no].base) {
      // 当前已经是太晶形态，可以变回
      addLabel('太晶化');
      add('\u21A9\uFE0F 解除太晶化', function () {
        teraRevert(petObj.no);
      });
    }

    /*
     * Evolution comes last, behind a divider, and only ever as an offer. Clicking
     * a glowing pet must not evolve it on the spot — this is the one irreversible
     * change in the whole skill, so it always costs one more deliberate tap.
     *
     * Rules (v4.5.3, silent when not actionable):
     *   · every route needs bond = 100, stones included;
     *   · when bond < 100 the whole "进化" section is hidden — no header, no
     *     "亲密度 x/100" bar, nothing. The user's word was: "未满和佩戴不变之石
     *     时不应该显示也不应该发光"；一个"你还差 47 点"的提示条本身也算显示；
     *   · a pet wearing the Everstone is likewise silent — the stone means "leave
     *     it alone", so surfacing anything evolution-related after that would be
     *     asking the same question twice.
     */
    var opts = bondEvoOptions(petObj.no);
    var stoneOpts = hasEverstone(petObj.no) ? [] : stonesFor(petObj.no);
    var hasAnyEvo = opts.length + stoneOpts.length > 0;
    var affNow = affectionOf(petObj.no);
    var full = affNow >= AFFECTION_MAX;

    if (hasAnyEvo && full && !hasEverstone(petObj.no)) {
      addLabel('进化');
      // 直接进化：无需道具的支线
      if (opts.length === 1) {
        add('\u2728 进化成' + labelOf(opts[0]), function () { evolvePet(petObj.no, opts[0]); });
      } else if (opts.length > 1) {
        // a branching family is a real choice, so name every branch
        opts.forEach(function (n) {
          add('\u2728 进化成' + labelOf(n), function () { evolvePet(petObj.no, n); });
        });
      }
      // 道具进化：满亲密度也需要用户主动给一颗石头
      stoneOpts.forEach(function (st) {
        add('\uD83D\uDC8E 给它' + st.zh + '（→' + labelOf(st.target) + '）', function () {
          useStone(petObj.no, st.stone);
        });
      });
    }
    if (isGmax(petObj.no)) {
      addLabel('超极巨化');
      add('\u21A9\uFE0F 恢复' + labelOf(gmaxBaseOf(petObj.no)) + '原本大小', function () { gmaxRevert(petObj.no); });
    } else if (canGmax(petObj.no)) {
      addLabel('超极巨化');
      gmaxOptions(petObj.no).forEach(function (id) {
        add('\uD83D\uDD34 ' + labelOf(id) + '（可随时变回）', function () { gmaxEvolve(petObj.no, id); });
      });
    } else if (gmaxOptions(petObj.no).length) {
      /* It has a Gigantamax form but cannot use it yet — say what is missing rather
         than hiding the entry, otherwise the feature looks absent. */
      addLabel('超极巨化');
      addLabel('\uD83D\uDD12 还差：' + gateReason(petObj.no));
    }
    if (isForm(petObj.no)) {
      add('\u21A9\uFE0F 变回' + labelOf(baseOf(petObj.no)), function () { megaRevert(petObj.no); });
    } else if (!canMega(petObj.no) && megaOptions(petObj.no).length) {
      addLabel('超级进化');
      addLabel('\uD83D\uDD12 还差：' + gateReason(petObj.no));
    } else if (canMega(petObj.no)) {
      /* Label it as the final stage, because that is what it now is: the ordinary
         line is already finished by the time this appears. */
      megaOptions(petObj.no).forEach(function (id) {
        add('\u26A1 ' + (FORMS[id].kind === 'primal' ? '原始回归' : '最终进化') + '：' + labelOf(id),
            function () { megaEvolve(petObj.no, id); });
      });
    } else if (megaOptions(petObj.no).length && evoOptions(petObj.no).length) {
      /* Has a mega but is not there yet. Say so rather than hiding it — otherwise
         the entry silently appears one evolution later with no explanation. */
      pop.appendChild((function () {
        var d = document.createElement('div');
        d.style.cssText = 'padding:6px 10px;font-size:11px;color:var(--qwp-fg2);';
        d.textContent = '先进化到最终形态，才能再超级进化';
        return d;
      })());
    }

    /* 给不变之石：有任何形态入口 + 满亲密度 + 没有不变之石 → 就能锁住 */
    var teraFormId2 = petObj.no + '-tera';
    var hasAnyForm = hasAnyEvo || megaOptions(petObj.no).length > 0 ||
                     gmaxOptions(petObj.no).length > 0 || !!TERA_FORMS[teraFormId2];
    if (hasAnyForm && full && !hasEverstone(petObj.no)) {
      add('\uD83E\uDEA8 给它不变之石（锁住所有变形）', function () {
        if (!S.everstone) S.everstone = {};
        S.everstone[petObj.no] = true;
        saveSettings(); refreshGlow();
        petObj.showTip('收下不变之石，形态锁住了', 3600);
      });
    }

    document.body.appendChild(pop);
    // anchor above-right of the click, then clamp into the viewport
    var r = pop.getBoundingClientRect();
    var x = Math.min(Math.max(6, cx + 8), window.innerWidth - r.width - 6);
    var y = Math.min(Math.max(6, cy - r.height - 10), window.innerHeight - r.height - 6);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top = Math.round(y) + 'px';

    setTimeout(function () {
      document.addEventListener('mousedown', onPopOutside, true);
      document.addEventListener('keydown', onPopKey, true);
    }, 0);
  }

  Pet.prototype.bind = function () {
    var self = this;
    var sprite = this.sprite;
    var startX = 0, startY = 0, ox = 0, oy = 0, moved = false;

    sprite.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      closePetPop();
      self.dragging = true; moved = false;
      startX = ev.clientX; startY = ev.clientY;
      ox = self.x; oy = self.y;
      self.el.classList.add('qwpoke-dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });

    function onMove(ev) {
      if (!self.dragging) return;
      var dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      self.x = ox + dx; self.y = oy + dy;
      self.draw();
      if (S.escapeToDesktop && nearEdge(ev.clientX, ev.clientY)) self.showTip('松手 → 跳到桌面', 900);
    }

    function onUp(ev) {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      self.dragging = false;
      self.el.classList.remove('qwpoke-dragging');
      if (!moved) { petChooser(self, ev.clientX, ev.clientY); return; }   // ask, don't assume 喂食
      if (S.escapeToDesktop && nearEdge(ev.clientX, ev.clientY)) { escapeToDesktop(self); return; }
      // stay where dropped, just keep it on screen
      self.clamp();
      self.draw();
      /* Remember the drop point in 'free' and 'right' modes. In bottom mode the
         next tick pulls it back to the floor, which is the point of that mode.
         In right mode the pet will walk toward a new waypoint eventually, but
         starts from the spot you left it — so dragging is a real "put it here". */
      if (placement() === 'free' || placement() === 'right') {
        if (!S.petPos) S.petPos = {};
        S.petPos[self.no] = { x: Math.round(self.x), y: Math.round(self.y) };
        saveSettings();
        // 右侧模式下拖放后重置 waypoint，让它从新位置开始下一段漫步
        if (placement() === 'right') self._wp = null;
      }
    }

    sprite.addEventListener('contextmenu', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      openPicker('food', self);      // this pet, not the whole team
    });
    sprite.addEventListener('dblclick', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      escapeToDesktop(self);
    });
    sprite.addEventListener('mouseenter', function () {
      if (self.dragging || self.busy) return;
      /* Hover tip: 名字 + 亲密度 + 一条趣味信息（不再写属性，属性已有彩色标签） */
      var pts = affectionOf(self.no);
      var g = genderOf(self.no);
      var tip = labelOf(self.no) + (g ? ' ' + GENDER_SIGN[g] : '') +
                ' · ' + affectionName(self.no) + ' ' + pts + '/' + AFFECTION_MAX;
      // 根据这只宝可梦的特征追加一条有趣的提示
      var funTip = '';
      var evoN = evoOptions(self.no).length + stonesFor(self.no).length;
      var regN = regionalOptionsFor(self.no).length;
      var gmaxN = gmaxOptions(self.no).length;
      var megaN = megaOptions(self.no).length;
      if (evoN > 1) {
        funTip = '有 ' + evoN + ' 种进化路线，养满亲密度就能选';
      } else if (evoN === 1 && pts < AFFECTION_MAX) {
        funTip = '再养养就能进化了';
      } else if (isMajorDimorphic(self.no)) {
        funTip = '试试切换性别，官方雌雄外观差很大';
      } else if (isDimorphic(self.no) && canChooseGender(self.no)) {
        funTip = '可以切换性别';
      } else if (regN > 0) {
        funTip = '还有地区形态可以切换（' + regN + ' 种）';
      } else if (gmaxN > 0 && pts >= AFFECTION_MAX) {
        funTip = '可以超极巨化！';
      } else if (megaN > 0 && pts >= AFFECTION_MAX) {
        funTip = '可以最终进化（超级进化）';
      } else if (hasEverstone(self.no)) {
        funTip = '已收下不变之石';
      } else {
        // 通用趣味小知识池
        var trivia = [
          '每只宝可梦都有自己的步行节奏',
          '喂食攒亲密度，陪伴也能涨',
          '双击立绘可以给训练家改名',
          '把它拖到哪里它就记住那个位置',
          '右键它可以直接喂食',
          '属性标签在悬停时自动显示',
          '给一只满亲密度的宠物不变之石，金光会熄灭',
          '卡牌可以设成背景板',
          '进化后亲密度清零重新攒',
          '同时开多个工作台，每个都会出现宠物'
        ];
        var hash = 0; for (var ci = 0; ci < String(self.no).length; ci++) hash = (hash * 7 + String(self.no).charCodeAt(ci)) % trivia.length;
        funTip = trivia[hash];
      }
      var showFun = funTip && Math.random() < 0.3;
      if (showFun) tip += '\n' + funTip;
      self.showTip(tip, showFun ? 2400 : 1400);
    });
  };

  function nearEdge(cx, cy) {
    var m = 26;
    return cx < m || cy < m || cx > window.innerWidth - m || cy > window.innerHeight - m;
  }

  /** Hand a pokemon over to the standalone desktop app. */
  /**
   * Hand a pokemon over to the standalone desktop app.
   *
   * The pet only leaves the team once the daemon confirms the app actually
   * started. Removing it first (the old behaviour) meant that when no standalone
   * app was installed the pokemon simply vanished — nothing appeared on the
   * desktop and the user had to hit 召回 to get it back.
   */
  function escapeToDesktop(petObj) {
    if (!BRIDGE) { petObj.showTip('桌面模式不可用', 1600); return; }
    if (!DESKTOP_READY) { petObj.showTip(DESKTOP_NOTE, 2800); return; }
    // the bridge only answers once the pet is really on screen, and a first
    // launch can take 10-20s — say so, and dim the pet so the wait reads as
    // "working" rather than "nothing happened"
    petObj.showTip('正在唤出到桌面…', 30000);
    if (petObj.el) { petObj.el.style.transition = 'opacity .2s'; petObj.el.style.opacity = '.45'; }
    bridgeCall('escape', { no: petObj.no, size: petSizeOf(petObj.no), label: labelOf(petObj.no) })
      .then(function (res) {
        if (!res || res.ok !== true) {
          // put it back where it was instead of losing it
          petObj.showTip('桌面程序没起来，留在窗口里', 2400);
          if (petObj.el) { petObj.el.style.opacity = '1'; }
          return;
        }
        petObj.showTip('去桌面玩了~', 1200);
        if (S.escapedTo.indexOf(petObj.no) === -1) S.escapedTo.push(petObj.no);
        var i = S.team.indexOf(petObj.no);
        if (i >= 0) S.team.splice(i, 1);
        saveSettings();
        if (petObj.el) {
          petObj.el.style.transition = 'opacity .35s, transform .35s';
          petObj.el.style.opacity = '0';
          setTimeout(function () { applyPets(); }, 380);
        } else {
          applyPets();
        }
      });
  }

  /** Bring whoever is out on the desktop back into the app window. */
  function recallFromDesktop() {
    bridgeCall('recall', {});
    var back = S.escapedTo.slice();
    // no silent default: recalling with nobody outside used to conjure a pikachu
    if (!back.length) return;
    for (var i = 0; i < back.length; i++) {
      if (S.team.length >= MAX_TEAM) break;
      if (S.team.indexOf(back[i]) === -1) S.team.push(back[i]);
    }
    S.escapedTo = [];
    S.petsEnabled = true;
    saveSettings();
    applyPets();
    // Desktop feeding writes the host-independent state file. Pull immediately on
    // return instead of waiting for a reload, otherwise the window keeps showing
    // its stale localStorage bond value and looks like progress was lost.
    try { pullGrowth(); } catch (e) {}
    if (PETS.length) PETS[PETS.length - 1].showTip('我回来了！', 1600);
  }

  // ---------- idle action set (ported from the desktop pet) ----------
  /**
   * Same repertoire the standalone pet uses. Each returns a promise and drives
   * the sprite's own transform, so it composes with the walk loop (which is
   * paused via `busy` while an action plays).
   */
  Pet.prototype.act = function (name) {
    if (this.busy || !this.sprite) return Promise.resolve();
    var self = this;
    var flip = this.dir < 0 ? ' scaleX(-1)' : '';
    var f = function (t) { return { transform: t + flip }; };
    var seq, dur = 900, easing = 'ease-in-out';

    switch (name) {
      case 'breathe':
        seq = [f('scale(1)'), f('scaleY(1.05) scaleX(.97)'), f('scale(1)'),
               f('scaleY(1.05) scaleX(.97)'), f('scale(1)')];
        dur = 2200; easing = 'ease-in-out'; break;
      case 'nod':
        seq = [f('rotate(0deg)'), f('rotate(9deg)'), f('rotate(0deg)'),
               f('rotate(-4deg)'), f('rotate(0deg)'), f('rotate(9deg)'), f('rotate(0deg)')];
        dur = 1100; break;
      case 'sway':
        seq = [f('rotate(0deg)'), f('rotate(10deg)'), f('rotate(-10deg)'),
               f('rotate(8deg)'), f('rotate(-8deg)'), f('rotate(0deg)')];
        dur = 1600; break;
      case 'hop':
        seq = [f('translateY(0)'), f('translateY(-26px) scaleX(1.05)'), f('translateY(0)'),
               f('translateY(-16px)'), f('translateY(0)'), f('translateY(-8px)'), f('translateY(0)')];
        dur = 1100; easing = 'ease-out'; break;
      case 'spin':
        seq = [f('scaleX(1)'), f('scaleX(.1)'), f('scaleX(-1)'), f('scaleX(-.1)'), f('scaleX(1)')];
        dur = 900; easing = 'linear'; break;
      case 'doze':
        seq = [f('translateY(0) scaleY(1)'), f('translateY(10px) scaleY(.9)'),
               f('translateY(12px) scaleY(.88)'), f('translateY(0) scaleY(1)')];
        dur = 2600; break;
      case 'shake':
        seq = [f('translateX(0)'), f('translateX(-5px)'), f('translateX(5px)'),
               f('translateX(-4px)'), f('translateX(4px)'), f('translateX(0)')];
        dur = 700; break;
      case 'stretch':
        seq = [f('scale(1)'), f('scale(1.16)'), f('scale(1.1)'), f('scale(1)')];
        dur = 1200; break;
      case 'dash': {
        // a quick scoot along the floor, then settle
        var maxX = Math.max(0, window.innerWidth - petSizeOf(this.no));
        var target = Math.min(maxX, Math.max(0, this.x + this.dir * 160));
        this.busy = true;
        var from = this.x;
        var t0 = performance.now();
        return new Promise(function (resolve) {
          var step = function (t) {
            var k = Math.min(1, (t - t0) / 520);
            self.x = from + (target - from) * (1 - Math.pow(1 - k, 3));
            self.draw();
            if (k < 1) requestAnimationFrame(step);
            else { self.busy = false; resolve(); }
          };
          requestAnimationFrame(step);
        });
      }
      default:
        return Promise.resolve();
    }

    this.busy = true;
    var anim = this.sprite.animate(seq, { duration: dur, easing: easing });
    /*
     * Race the animation against a plain timer. When the host window is hidden or
     * occluded the compositor is suspended and `anim.finished` never settles —
     * measured: rendering stopped, `busy` stayed true forever, and from then on
     * draw() skipped the facing update and tick() refused to move the pet at all.
     * A timer is not throttled away entirely, so this always releases `busy`.
     */
    return Promise.race([anim.finished || sleep(dur), sleep(dur + 250)]).then(function () {
      self.busy = false;
      self.draw();
    }, function () { self.busy = false; });
  };

  var ACTION_NAMES = ['breathe', 'nod', 'sway', 'hop', 'spin', 'doze', 'shake', 'stretch', 'dash'];
  /*
   * Pick an idle action that suits the current placement. 'dash' scoots 160px
   * sideways, which contradicts "stays where you put it" and does not persist the
   * new spot, so it is off the table in free mode. Every random pick goes through
   * here — there are three call sites and the first fix only covered one.
   */
  function randomAction() {
    var pool = placement() === 'free'
      ? ACTION_NAMES.filter(function (n) { return n !== 'dash'; })
      : ACTION_NAMES;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  var idleTimer = null;
  function scheduleIdle() {
    clearTimeout(idleTimer);
    var delay = 6000 + Math.random() * 9000;
    idleTimer = setTimeout(function () {
      if (S.idleActions && PETS.length) {
        var p = PETS[Math.floor(Math.random() * PETS.length)];
        /* 'dash' scoots 160px sideways. That is fine for a pet that walks a rail
           anyway, but in 'free' mode the whole promise is "stays where you put
           it" — measured: it dragged a pet from x=317 to x=159, and the new spot
           was never saved, so a re-injection snapped it back again. */
        if (!p.dragging && !p.busy) p.act(randomAction());
      }
      scheduleIdle();
    }, delay);
  }

  /* ---------- reminder engine ----------
   * Two clocks, deliberately separate:
   *   · interval  — 喝水 / 久坐 / 护眼, every careMinutes, rotating between the three
   *                 kinds so the same nag never repeats back to back.
   *   · wall time — 吃饭 (12:00 / 18:00) and 睡觉 (every hour from 20:00), which are
   *                 meaningless on an interval: "go eat" has to land at lunchtime,
   *                 not 45 minutes after you happened to open the app.
   * All of it is gated on careBubbles, and nothing schedules network work — the
   * pet reads the local clock, so no task or timer outside the page is involved.
   */
  function noticeLines(bucket) {
    var lib = (S.noticeMsgs && typeof S.noticeMsgs === 'object') ? S.noticeMsgs : {};
    var lines = Array.isArray(lib[bucket]) ? lib[bucket] : null;
    if (!lines || !lines.length) lines = DEFAULTS.noticeMsgs[bucket] || [];
    return lines.map(function (m) { return String(m == null ? '' : m).trim(); })
                .filter(function (m) { return m; });
  }

  /* Say one line from a bucket. Returns whether it actually spoke, so the wall
     clock can hold its "already fired" stamp back until the pet really talked
     (no pets mounted yet at boot would otherwise burn the slot for the day). */
  function sayFrom(bucket, ms, act) {
    if (!S.careBubbles || !PETS.length) return false;
    var lines = noticeLines(bucket);
    if (!lines.length) return false;
    var p = PETS[Math.floor(Math.random() * PETS.length)];
    if (!p || !p.showTip) return false;
    p.showTip(lines[Math.floor(Math.random() * lines.length)], ms || 4600);
    if (act) p.act(act);
    return true;
  }

  var careTimer = null;
  var INTERVAL_BUCKETS = ['water', 'sit', 'eyes'];
  var intervalTurn = 0;
  function scheduleCare() {
    clearTimeout(careTimer);
    // honour the user's interval; floor at 1 min so a stray 0 can't busy-loop
    var mins = Math.max(1, Number(S.careMinutes) || 45);
    careTimer = setTimeout(function () {
      try {
        var bucket = INTERVAL_BUCKETS[intervalTurn % INTERVAL_BUCKETS.length];
        if (sayFrom(bucket, 4600)) intervalTurn++;   // only advance when it spoke
      } catch (e) {}
      scheduleCare();     // re-arm regardless, so toggling on later just works
    }, mins * 60 * 1000);
  }

  /*
   * Wall-clock slots. Stamps live in their own localStorage key rather than in
   * settings: they are bookkeeping, they change several times a day, and mixing
   * them into the settings blob would rewrite (and risk clobbering) real user
   * choices on every tick. Persisting them at all is the point — the daemon
   * re-injects the runtime whenever it finds the page without it, and in-memory
   * stamps would let every re-injection nag about lunch again.
   */
  var STAMP_LS = 'qwpoke.notice.stamps.v1';
  function readStamps() {
    try { return JSON.parse(localStorage.getItem(STAMP_LS) || '{}') || {}; } catch (e) { return {}; }
  }
  function stampDone(key) {
    var st = readStamps();
    st[key] = Date.now();
    // keep only recent keys so this cannot grow without bound
    var keys = Object.keys(st);
    if (keys.length > 40) {
      keys.sort(function (a, b) { return st[a] - st[b]; });
      keys.slice(0, keys.length - 40).forEach(function (k) { delete st[k]; });
    }
    try { localStorage.setItem(STAMP_LS, JSON.stringify(st)); } catch (e) {}
  }
  function stampSeen(key) { return !!readStamps()[key]; }

  function dayKey(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /* Which wall-clock slot, if any, is due right now.
     Meals fire in the first minutes of 12:00 / 18:00; sleep fires on every hour
     from 20:00 onward (including past midnight) with copy that escalates by how
     late it is. A slot missed because the app was closed stays missed — waking up
     to "go eat lunch" at 4pm would be worse than silence. */
  function dueSlot(now) {
    var h = now.getHours(), m = now.getMinutes();
    if (m > 9) return null;                    // only near the top of the hour
    var day = dayKey(now);
    if (h === 12) return { key: 'lunch:' + day, bucket: 'lunch' };
    if (h === 18) return { key: 'dinner:' + day, bucket: 'dinner' };
    if (h >= 20 || h < 5) {
      /* Past midnight belongs to the night that started the evening before, so
         the hourly stamps of one long night never collide with the next day's. */
      var night = new Date(now.getTime());
      if (h < 5) night.setDate(night.getDate() - 1);
      var bucket = (h >= 20 && h <= 21) ? 'sleepEarly'
                 : (h >= 22 && h <= 23) ? 'sleepLate'
                 : 'sleepOvernight';
      return { key: 'sleep:' + dayKey(night) + ':' + h, bucket: bucket };
    }
    return null;
  }

  var clockTimer = null;
  function scheduleClockNotices() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    var tick = function () {
      try {
        if (!S.careBubbles) return;
        var slot = dueSlot(new Date());
        if (!slot || stampSeen(slot.key)) return;
        if (sayFrom(slot.bucket, 6500, 'nod')) stampDone(slot.key);
      } catch (e) {}
    };
    clockTimer = setInterval(tick, 60000);
    tick();                       // catch a slot we booted into
  }

  /* One greeting on the first launch of the day. Delayed a little so it does not
     collide with the pets still being mounted, and stamped per day so a
     re-injection mid-morning does not greet again. */
  function greetOnce() {
    setTimeout(function () {
      try {
        var key = 'start:' + dayKey(new Date());
        if (!S.careBubbles || stampSeen(key)) return;
        if (sayFrom('start', 6000, 'hop')) stampDone(key);
      } catch (e) {}
    }, 4000);
  }


  /* ---------- bond & evolution ----------
   * Two ways to earn a bond, both of them passive-friendly: feeding (a deliberate
   * act) and simply being kept company (time the pets are actually on screen).
   * At a full bond the pet starts glowing and evolution becomes available —
   * but never automatic. The user clicks the glowing pet and picks; a pet given
   * an everstone stops glowing and is left alone for good.
   *
   * Why not evolve on its own: evolution is the one irreversible change here, and
   * a pokemon someone spent days feeding must not silently turn into something
   * else while they were looking away.
   */
  var AFFECTION_MAX = 100;
  var FEED_GAIN = [3, 5];            // per feeding, inclusive random
  var COMPANION_MINUTES = 3;          // minutes of company per +1 bond (20pts/hr, 5h = 100)
  var COMPANION_LS = 'qwpoke.companion.v1';
  var AFFECTION_LEVELS = [
    { min: 0, name: '初识' },
    { min: 25, name: '熟悉' },
    { min: 50, name: '亲近' },
    { min: 80, name: '信赖' },
    { min: AFFECTION_MAX, name: '形影不离' }
  ];


  /* ---------- growth data that must outlive this host ----------
   *
   * Affection lived only in this host's localStorage, which lost it twice over:
   * another workspace showed a fresh 0-affection profile, and clearing site data
   * (or following the uninstall note that suggests it) threw the progress away.
   * The daemon now keeps a host-independent copy on disk; affection is merged by
   * MAX on both sides, so nothing here can ever lower it.
   */
  var GROWTH_KEYS = ['affection', 'everstone', 'evolved', 'nicknames',
    'cards', 'packLog', 'unlocked', 'cardFav'];
  var growthTimer = null;

  function pushGrowth() {
    if (growthTimer) clearTimeout(growthTimer);
    // debounced: feeding fires several saves in a row
    growthTimer = setTimeout(function () {
      growthTimer = null;
      var patch = {};
      GROWTH_KEYS.forEach(function (k) { patch[k] = S[k] || {}; });
      // A timestamp marks an explicit/migrated visual choice. A brand-new host has
      // no timestamp and therefore cannot overwrite another host's background.
      if (Number(S.appearanceUpdatedAt) > 0) patch.appearance = appearancePayload();
      /* Name the host so the daemon files the board under this workspace only.
       * Without it, choosing a board in one app repainted every other app, and
       * a density tuned for a light theme washed out a dark one. */
      patch.hostKey = HOST_KEY;
      bridgeCall('state', { op: 'save', state: patch });
    }, 800);
  }

  function pullGrowth() {
    return bridgeCall('state', { op: 'get' }).then(function (r) {
      if (!r || !r.ok || !r.state) return false;
      var d = r.state, changed = false, appearanceChanged = false;
      var mine = S.affection || {}, theirs = d.affection || {};
      for (var id in theirs) {
        var want = Math.max(0, Math.min(AFFECTION_MAX, Number(theirs[id]) || 0));
        if (want > (Number(mine[id]) || 0)) { mine[id] = want; changed = true; }
      }
      S.affection = mine;
      // flags + card economy only fill gaps: a stone the user removed here must not come back,
      // and a card drawn on another host is monotone-safe to add; a fav toggled locally wins.
      ['everstone', 'evolved', 'nicknames',
        'cards', 'packLog', 'unlocked', 'cardFav'].forEach(function (k) {
        var src = d[k] || {};
        if (!S[k]) S[k] = {};
        for (var id2 in src) {
          if (S[k][id2] === undefined) { S[k][id2] = src[id2]; changed = true; }
        }
      });
      // Background settings are last-write-wins as one coherent bundle. This lets a
      // fresh host recover the selected board, while an explicit "no board" choice
      // (which carries a newer timestamp) still propagates normally.
      /* Per-host board: read this workspace's own slot first, falling back to
       * the legacy global bundle so an install made before this change still
       * recovers its board on first read. */
      var byHost = (d.appearanceByHost && typeof d.appearanceByHost === 'object') ? d.appearanceByHost : {};
      var mineAppearance = (byHost[HOST_KEY] && typeof byHost[HOST_KEY] === 'object') ? byHost[HOST_KEY] : null;
      var theirsAppearance = mineAppearance
        || ((d.appearance && typeof d.appearance === 'object') ? d.appearance : {});
      var theirTs = Number(theirsAppearance._ts) || 0;
      var myTs = Number(S.appearanceUpdatedAt) || 0;
      if (theirTs > myTs) {
        APPEARANCE_KEYS.forEach(function (k2) {
          if (Object.prototype.hasOwnProperty.call(theirsAppearance, k2)) S[k2] = theirsAppearance[k2];
        });
        S.appearanceUpdatedAt = theirTs;
        appearanceSig = appearanceSignature(S);   // do not mint a new timestamp in saveSettings
        changed = true;
        appearanceChanged = true;
      } else if (myTs > theirTs) {
        // This host has the newer explicit choice (including the one-time migration).
        pushGrowth();
      }
      if (changed) {
        saveSettings();
        refreshGlow();
        applyPets();
        if (appearanceChanged) { applyTheme(); applyBg(); tagSurfaces(); }
      }
      return changed;
    }).catch(function () { return false; });
  }

  function affectionOf(no) {
    // 太晶形态共享本体亲密度
    var key = (TERA_FORMS[no] && TERA_FORMS[no].base) || no;
    var v = (S.affection && S.affection[key]) || 0;
    // clamp on read: a hand-edited or older blob may hold anything
    return Math.max(0, Math.min(AFFECTION_MAX, Number(v) || 0));
  }
  function affectionName(no) {
    var pts = affectionOf(no), name = AFFECTION_LEVELS[0].name;
    for (var i = 0; i < AFFECTION_LEVELS.length; i++) {
      if (pts >= AFFECTION_LEVELS[i].min) name = AFFECTION_LEVELS[i].name;
    }
    return name;
  }
  function isCustom(no) { return String(no).indexOf('my:') === 0; }

  /* Direct successors that we can actually render. Filtering on entryOf matters:
     the graph covers the whole national dex while the sprite set on disk may be
     missing a few (the downloader tolerates a small number of misses), and
     evolving into a missing sprite yields an invisible pet that still walks. */
  /** The counterpart of `speciesId` in the same regional line, if one exists. */
  function regionalTwin(speciesId, kind) {
    for (var rid in REGIONAL_FORMS) {
      var r = REGIONAL_FORMS[rid];
      if (r.base === speciesId && r.kind === kind) return rid;
    }
    return '';
  }

  function evoOptions(no) {
    /* A mega form is not a stage: it has no `next`, and letting it evolve would
       strand the pokemon in a form it could never revert from. Gigantamax likewise. */
    if (isCustom(no) || isForm(no) || isGmax(no)) return [];
    /* A regional form evolves along ITS OWN line: Hisuian Sliggoo becomes Hisuian
       Goodra, not the Kalos one. The graph is keyed by species number only, so map
       through the base species and then back to the regional counterpart. Without
       this a regional form could not evolve at all, which also made the unlock text
       ("raise it and evolve") a promise the code could not keep. */
    var rf = REGIONAL_FORMS[no];
    if (rf) {
      var eb = EVOLUTIONS[rf.base];
      if (!eb || !Array.isArray(eb.next)) return [];
      return eb.next.map(function (n) {
        var twin = regionalTwin(n, rf.kind);
        return twin || n;
      }).filter(function (n) { return !!entryOf(n); });
    }
    var e = EVOLUTIONS[no];
    if (!e || !Array.isArray(e.next)) return [];
    return e.next.filter(function (n) { return !!entryOf(n); });
  }
  function hasEverstone(no) { return !!(S.everstone && S.everstone[no]); }
  /* ---------- 形态解锁 (form gating) ----------
   * Letting the picker offer every evolved form directly made evolution pointless:
   * you could just select Ninetales instead of raising a Vulpix into one. So the
   * roster only offers BASE forms, and anything further up a line has to be earned
   * once — after that it stays unlocked and can be picked freely, because re-raising
   * the same pokemon to see a form you already earned is busywork, not progress.
   */
  function preEvolutionOf(no) {
    var e = EVOLUTIONS[no];
    return (e && e.from) || '';
  }
  /** A base form is what you may pick freely: nothing evolves into it, and it is
      not a mega / primal / gigantamax transformation of something else. */
  function isBaseForm(no) {
    if (isCustom(no)) return true;                       // photo pets are always yours
    if (FORMS[no]) return false;                         // mega / primal
    var rf = REGIONAL_FORMS[no];
    if (rf) {
      if (rf.kind === 'gmax') return false;              // gigantamax is a transformation
      // a regional form is a base only when its species has no pre-evolution
      return !preEvolutionOf(rf.base);
    }
    return !preEvolutionOf(no);
  }
  function isUnlocked(no) {
    if (isBaseForm(no)) return true;
    if (S.unlocked && S.unlocked[no]) return true;
    // anything already in the team or already marked evolved counts as earned,
    // so an existing save is not suddenly told its pokemon are illegal
    if (S.team && S.team.indexOf(no) >= 0) return true;
    if (S.evolved && S.evolved[no]) return true;
    /* A recorded bond is the strongest possible proof of ownership: points only
       accrue on a pet the user actually kept and fed. Saves made before gating
       existed are full of maxed-out evolved forms, and telling their owner to
       "go raise the pre-evolution first" would be taking away earned progress. */
    if (affectionOf(no) > 0) return true;
    return !!(S.nicknames && S.nicknames[no]);
  }
  function markUnlocked(no) {
    if (!no) return;
    if (!S.unlocked) S.unlocked = {};
    S.unlocked[no] = 1;
  }

  /** Human-readable requirement for a form that is still locked. */
  function unlockReason(no) {
    if (isUnlocked(no)) return '';
    if (FORMS[no]) {
      return '需要先把' + labelOf(FORMS[no].base) + '养到亲密度 ' + AFFECTION_MAX +
             '、走完普通进化，再点它超级进化';
    }
    var rf = REGIONAL_FORMS[no];
    if (rf && rf.kind === 'gmax') {
      return '需要先把' + labelOf(rf.base) + '养到亲密度 ' + AFFECTION_MAX +
             '、走完普通进化，再点它超极巨化';
    }
    /* For a regional form the predecessor is the regional form of the pre-evolution,
       not the base-species one: Alolan Ninetales comes from Alolan Vulpix with an
       Ice Stone, and quoting the Kanto line's Fire Stone here was simply wrong. */
    var from = '';
    if (rf) {
      var prevBase = preEvolutionOf(rf.base);
      if (prevBase) {
        from = regionalTwin(prevBase, rf.kind);
        /* No regional counterpart for the pre-evolution (Hisuian Sliggoo has no
           Hisuian Goomy): the only way in is to raise the ordinary line and then
           switch form, so say that instead of promising an evolution that would
           actually produce the ordinary form. */
        if (!from) {
          return '需要先养出' + labelOf(rf.base) + '（' + labelOf(prevBase) + '进化而来），' +
                 '再点它切换成' + (REGION_ZH[rf.kind] || rf.kind) + '的样子';
        }
      } else {
        return '需要点' + labelOf(rf.base) + '切换成' + (REGION_ZH[rf.kind] || rf.kind) + '的样子';
      }
    } else {
      from = preEvolutionOf(no);
    }
    if (!from) return '暂时无法获得';
    // an item evolution states the item; everything else states the bond
    var viaStone = '';
    for (var key in STONES_DATA) {
      var t = STONES_DATA[key] && STONES_DATA[key].targets;
      if (t && t[from] === no) { viaStone = STONES_DATA[key].zh; break; }
    }
    if (viaStone) return '需要给' + labelOf(from) + viaStone + '（亲密度不限）';
    return '需要把' + labelOf(from) + '养到亲密度 ' + AFFECTION_MAX + ' 后点它进化';
  }

  function isEvolved(no) { return !!(S.evolved && S.evolved[no]); }
  /* Ready = bond full, no everstone, and at least ONE route (bond-based or
     stone-based) exists. Now that stones share the bond gate, a Pikachu at 100 is
     just as "ready to evolve" as a Charmander — it just needs a stone from the
     user in one case and nothing in the other. */
  function canEvolve(no) {
    if (affectionOf(no) < AFFECTION_MAX) return false;
    if (hasEverstone(no)) return false;
    return bondEvoOptions(no).length > 0 || stonesFor(no).length > 0;
  }

  /* Paint the two gold states. They mean different things and must look
     different: a bright pulse + label is an invitation to click, while a faint
     steady aura is just a badge saying "this one has evolved before". */
  function applyGlow(pet) {
    if (!pet || !pet.el) return;
    /* An item evolution is actionable right now, so it lights the same invitation
       as a full bond — otherwise a Vulpix holding a Fire Stone looks inert. */
    var gmax = isGmax(pet.no);
    var mega = isForm(pet.no);
    var ready = !gmax && !mega &&
                (canEvolve(pet.no) || canMega(pet.no) || canGmax(pet.no));
    pet.el.classList.toggle('qwpoke-ready', ready);
    pet.el.classList.toggle('qwpoke-mega', mega);
    pet.el.classList.toggle('qwpoke-gmax', gmax);
    pet.el.classList.toggle('qwpoke-evolved', !ready && !mega && !gmax && isEvolved(pet.no));
    var label = pet.el.querySelector('.qwpoke-readytag');
    if (ready && !label) {
      label = document.createElement('div');
      label.className = 'qwpoke-readytag';
      label.textContent = '可进化 · 点我';
      pet.el.appendChild(label);
    } else if (!ready && label) {
      label.parentNode.removeChild(label);
    }
  }
  function refreshGlow() { PETS.forEach(applyGlow); }

  /* Add bond points. Returns what happened so the caller can talk about it. */
  function addAffection(no, gain) {
    if (!S.affection) S.affection = {};
    var before = affectionOf(no);
    if (before >= AFFECTION_MAX) return { pts: before, gain: 0, ready: canEvolve(no) };
    var g = gain || (FEED_GAIN[0] + Math.floor(Math.random() * (FEED_GAIN[1] - FEED_GAIN[0] + 1)));
    var after = Math.min(AFFECTION_MAX, before + g);
    S.affection[no] = after;
    // first time this pokemon reaches a full bond, bank a pack
    var earned = 0;
    if (after >= AFFECTION_MAX && before < AFFECTION_MAX) earned = grantPackOnce('bond100:' + no, 'bond');
    saveSettings();
    refreshGlow();
    return { pts: after, gain: after - before, full: after >= AFFECTION_MAX,
             ready: canEvolve(no), pack: earned };
  }

  /*
   * Company timer. Progress lives in its own localStorage key, not in settings:
   * it ticks every minute and would otherwise rewrite the whole settings blob
   * (and risk clobbering real choices) sixty times an hour.
   *
   * Only elapsed time we actually observed counts. `lastAt` is compared against a
   * ceiling, so hours during which the app was closed — or the machine asleep —
   * do not turn into bond points the moment it reopens.
   */
  var companionTimer = null;
  var COMPANION_TICK = 60000;
  var COMPANION_MAX_GAP = 150000;     // 2.5 min: tolerate a slow tick, reject a closed app
  function readCompanion() {
    try { return JSON.parse(localStorage.getItem(COMPANION_LS) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeCompanion(st) {
    try { localStorage.setItem(COMPANION_LS, JSON.stringify(st)); } catch (e) {}
  }
  function companionTick() {
    try {
      var st = readCompanion();
      var now = Date.now();
      var mins = Number(st.min) || 0;
      if (st.lastAt && now > st.lastAt) {
        var gap = Math.min(now - st.lastAt, COMPANION_MAX_GAP);
        if (PETS.length && !document.hidden) mins += gap / 60000;
      }
      st.lastAt = now;
      var awarded = 0;
      while (mins >= COMPANION_MINUTES) { mins -= COMPANION_MINUTES; awarded++; }
      st.min = mins;
      writeCompanion(st);
      if (!awarded || !PETS.length) return;
      // everyone on screen shares the company, custom pets included
      var seen = {};
      PETS.forEach(function (p) {
        if (seen[p.no]) return;        // same species twice must not double-count
        seen[p.no] = 1;
        addAffection(p.no, awarded);
      });
    } catch (e) { /* never let bookkeeping break the pet */ }
  }
  function scheduleCompanion() {
    if (companionTimer) { clearInterval(companionTimer); companionTimer = null; }
    var st = readCompanion();
    st.lastAt = Date.now();            // start counting from now, not from last run
    writeCompanion(st);
    companionTimer = setInterval(companionTick, COMPANION_TICK);
  }

  /*
   * Perform the evolution. Everything keyed by pokedex number has to move with
   * it, or the bond and the nickname the user built up vanish at the exact moment
   * they are being rewarded. The bond itself is spent: the evolved form starts
   * over, so a three-stage family is three separate bonds rather than three
   * clicks in a row.
   */
  function evolvePet(no, target) {
    /*
     * Re-check eligibility here, not only in the menu. The menu is one caller and
     * the exposed API is another; a pet wearing an everstone has to be safe from
     * every path, because the whole point of the stone is the user saying "leave
     * this one alone". Measured before this guard existed: calling evolve()
     * directly happily evolved a stoned pokemon into its first successor.
     */
    if (!canEvolve(no)) return null;
    /* 直接进化只走无需道具的路线：把 stone-only 目标筛掉后再选，否则一只满亲密度
       的皮卡丘会被无声地直进化成雷丘而没用过雷之石。 */
    var opts = bondEvoOptions(no);
    if (!opts.length) return null;
    var newNo = (target && opts.indexOf(target) >= 0) ? target : opts[0];
    if (!entryOf(newNo)) return null;

    var idx = S.team.indexOf(no);
    if (idx < 0) return null;
    S.team[idx] = newNo;

    if (S.affection) { delete S.affection[no]; S.affection[newNo] = 0; }
    if (S.nicknames && S.nicknames[no] && !S.nicknames[newNo]) {
      S.nicknames[newNo] = S.nicknames[no];
      delete S.nicknames[no];
    }
    if (S.everstone) delete S.everstone[no];      // the stone was never used
    if (!S.evolved) S.evolved = {};
    S.evolved[newNo] = true;
    delete S.evolved[no];
    markUnlocked(newNo);                 // earned: it can be picked directly from now on
    grantPackOnce('evo:' + newNo, 'evolve');
    saveSettings();
    applyPets();                                  // roster changed -> rebuild
    refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) { p.showTip('进化成' + labelOf(newNo) + '啦！', 5000); p.act('spin'); }
    return newNo;
  }

  /* ---------- mega evolution ----------
   * Deliberately NOT a stage in the evolution graph. In canon a Mega Evolution
   * lasts one battle and reverts, so here it is a toggle: it does not consume the
   * bond, does not need an everstone to refuse (you can always change back), and
   * a form can revert to its base at any time. Ordinary evolution stays the
   * one-way, bond-spending change.
   */
  function isForm(no) { return !!FORMS[no]; }
  function baseOf(no) { return (FORMS[no] && FORMS[no].base) || no; }
  /* Which mega forms this pokemon can take, filtered to ones we can render. */
  function megaOptions(no) {
    if (isCustom(no) || isForm(no)) return [];
    var out = [];
    for (var id in FORMS) {
      if (FORMS[id].base === no && entryOf(id)) out.push(id);
    }
    return out.sort();
  }
  /*
   * Mega is the LAST rung of the ladder, not a shortcut off the side of it.
   *   · a full bond, same bar as ordinary evolution
   *   · nothing ordinary left to evolve into — you finish the line first. Only one
   *     species in the whole set needs this gate (Floette still becomes Florges
   *     yet already has a mega), but without it that one could mega early and
   *     never reach its real final form.
   *   · an everstone blocks it too: the user said "stop changing", and honouring
   *     that for evolution while quietly allowing mega would be a lie.
   */
  function canMega(no) {
    return affectionOf(no) >= AFFECTION_MAX &&
           !hasEverstone(no) &&
           evoOptions(no).length === 0 &&
           megaOptions(no).length > 0;
  }
  function megaEvolve(no, target) {
    if (!canMega(no)) return null;
    var opts = megaOptions(no);
    var formId = (target && opts.indexOf(target) >= 0) ? target : opts[0];
    var idx = S.team.indexOf(no);
    if (idx < 0 || !entryOf(formId)) return null;
    S.team[idx] = formId;
    /* Carry the bond across instead of spending it: this is reversible, so
       charging for it would punish the user for looking at the mega form. */
    if (!S.affection) S.affection = {};
    S.affection[formId] = affectionOf(no);
    if (S.nicknames && S.nicknames[no] && !S.nicknames[formId]) S.nicknames[formId] = S.nicknames[no];
    markUnlocked(formId);
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) { p.showTip('超级进化！' + labelOf(formId), 5000); p.act('spin'); }
    return formId;
  }
  function megaRevert(no) {
    if (!isForm(no)) return null;
    var base = baseOf(no);
    var idx = S.team.indexOf(no);
    if (idx < 0 || !entryOf(base)) return null;
    S.team[idx] = base;
    if (!S.affection) S.affection = {};
    S.affection[base] = affectionOf(no);
    delete S.affection[no];
    if (S.nicknames && S.nicknames[no] && !S.nicknames[base]) {
      S.nicknames[base] = S.nicknames[no];
      delete S.nicknames[no];
    }
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) p.showTip('变回' + labelOf(base) + '了', 4000);
    return base;
  }

  /* ---------- 太晶化切换 ---------- */
  function teraEvolve(no, teraId) {
    var tf = TERA_FORMS[teraId];
    if (!tf) return null;
    var idx = S.team.indexOf(no);
    if (idx < 0) return null;
    S.team[idx] = teraId;
    // 太晶化共享本体亲密度，不单独存
    if (S.nicknames && S.nicknames[no] && !S.nicknames[teraId]) S.nicknames[teraId] = S.nicknames[no];
    markUnlocked(teraId);
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS.filter(function (x) { return x.no === teraId; })[0];
    if (p && p.showTip) { p.showTip('太晶化！' + labelOf(teraId), 4000); }
    return teraId;
  }
  function teraRevert(no) {
    var tf = TERA_FORMS[no];
    if (!tf || !tf.base) return null;
    var base = tf.base;
    var idx = S.team.indexOf(no);
    if (idx < 0) return null;
    S.team[idx] = base;
    // 不动亲密度，太晶形态共享本体的
    if (S.nicknames && S.nicknames[no] && !S.nicknames[base]) {
      S.nicknames[base] = S.nicknames[no];
    }
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS.filter(function (x) { return x.no === base; })[0];
    if (p && p.showTip) p.showTip('太晶化解除，变回' + labelOf(base), 3000);
    return base;
  }

  /* ---------- collection (开包收集) ----------
   * Packs are earned by playing, never bought or timed:
   *   · a pokemon reaching a full bond for the first time
   *   · finishing an evolution
   *   · each feeding, capped per day so it stays a daily rhythm rather than a grind
   * Opening draws 5 items the user does not already own, so a pack is never a
   * duplicate — with a finite catalog, duplicates would make the last few items
   * unreachable in practice.
   */
  var PACK_SIZE = 5;
  var FEED_PACKS_PER_DAY = 6;

  function dayStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function ownedCards() { return S.cards || (S.cards = {}); }
  function ownsCard(file) { return !!ownedCards()[file]; }
  function ownedCount() { return Object.keys(ownedCards()).length; }

  function grantPack(reason, n) {
    S.packs = Math.max(0, (Number(S.packs) || 0) + (n || 1));
    saveSettings();
    return S.packs;
  }
  /** One-off earns (first full bond, an evolution) use a marker so they cannot farm. */
  function grantPackOnce(key, reason) {
    if (!S.packLog) S.packLog = {};
    if (S.packLog[key]) return 0;
    S.packLog[key] = Date.now();
    grantPack(reason, 1);
    return 1;
  }
  /** Feeding earns a pack up to a daily cap. Returns how many were granted. */
  function grantPackForFeed() {
    var today = dayStamp();
    if (S.feedDay !== today) { S.feedDay = today; S.feedCount = 0; }
    if ((Number(S.feedCount) || 0) >= FEED_PACKS_PER_DAY) { saveSettings(); return 0; }
    S.feedCount = (Number(S.feedCount) || 0) + 1;
    grantPack('feed', 1);
    return 1;
  }
  function feedPacksLeftToday() {
    if (S.feedDay !== dayStamp()) return FEED_PACKS_PER_DAY;
    return Math.max(0, FEED_PACKS_PER_DAY - (Number(S.feedCount) || 0));
  }

  /** Draw PACK_SIZE unowned items. Returns the drawn entries (may be shorter at the end). */
  function openPack(setId) {
    if ((Number(S.packs) || 0) <= 0) return [];
    /* 只从选中的扩充包里抽：用户要"选择抽哪个卡包"，那抽到的就必须来自那个包，
       否则选择没有意义。该包抽完了才回落到全部。 */
    var pool = cardsOfSet(setId).filter(function (c) { return !ownsCard(c.file); });
    if (!pool.length) pool = CARD_LIST.filter(function (c) { return !ownsCard(c.file); });
    if (!pool.length) return [];
    var got = [];
    for (var i = 0; i < PACK_SIZE && pool.length; i++) {
      var idx = Math.floor(Math.random() * pool.length);
      var pick = pool.splice(idx, 1)[0];
      ownedCards()[pick.file] = 1;
      got.push(pick);
    }
    S.packs = Math.max(0, (Number(S.packs) || 0) - 1);
    saveSettings();
    return got;
  }

  /* ---------- 开包体验 ----------
   * 三段式，刻意做成有过程而不是一次弹出结果：
   *   ① 选中的卡包立起来 → ② 沿虚线撕开顶封（CSS 3D 翻折 + 抖动）→ ③ 逐张翻牌
   * 原游戏的撕开是引擎渲染的，拿不到序列帧，所以用卡包封面图 + clip 分层复刻手感。
   */
  function cardsOfSet(setId) {
    return CARD_LIST.filter(function (c) { return !setId || c.set === setId; });
  }
  /* 卡名优先用中文：卡面本身是中文的，标签还写英文会像两套东西拼在一起。
     顺手解掉源页面带来的 HTML 实体（Farfetch&#039;d → Farfetch'd）。 */
  function unentity(s) {
    return String(s || '').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
                          .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  function labelOfCard(c) {
    if (!c) return '';
    return unentity(c.zh || c.label);
  }
  function packCoverFor(setId) {
    /* 必须是确定性的：以前用 Math.random 挑候选，导致每次 render（用户点一下
       任何一个卡包都会 render 一次）下方 grid 里所有卡包都可能换一张封面，
       看起来像"整排都在重排"。按文件名升序取第一张，稳定映射一个 set 到一
       张封面，撕开动画也是同一张，跟 grid 里看到的一致。 */
    var hit = PACK_LIST.filter(function (p) { return p.set === setId; })
                       .sort(function (a, b) { return String(a.file).localeCompare(String(b.file)); });
    if (hit.length) return hit[0];
    /* 找不到真正的封面时，退回到「用本 set 的一张卡当封面」——原来的兜底是
       "整体第一张"，会让 B3a/B3b/B4/P-B 都指向 A1_卡包1，用户看着就是「卡包
       重复」。改成从这个 set 里挑最稀有那一张（tier 最高、no 最小）当代替，
       至少视觉上属于本包，不会被误读成别的包。 */
    var subs = cardsOfSet(setId).slice()
      .sort(function (a, b) { return (b.tier || 0) - (a.tier || 0) || (a.no - b.no); });
    if (subs.length) {
      return { file: subs[0].file, path: subs[0].path, set: setId, fallback: true };
    }
    return null;
  }

  /** 逐张揭示，最后给一张总览。resolve 后回到收藏册。 */
  function revealCards(list) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'qwpoke-open';
      var wrap = document.createElement('div');
      wrap.className = 'qwpoke-reveal';
      var bar = document.createElement('div');
      bar.className = 'qwpoke-revealbar';
      ov.appendChild(wrap); ov.appendChild(bar);
      document.body.appendChild(ov);

      /* Escape 与点空白都要能走完/退出：揭示是动画，不是需要确认的对话框，
         被它挡着找不到出口是最容易让人恼的一种交互。 */
      var onKey = null;
      var finish = function () {
        if (onKey) document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve();
      };

      var summary = function () {
        wrap.remove(); bar.remove();
        var box = document.createElement('div');
        box.className = 'qwpoke-summary';
        var t = document.createElement('div');
        t.className = 'qwpoke-sumtitle';
        t.textContent = '本次开出 ' + list.length + ' 张新卡';
        var g = document.createElement('div');
        g.className = 'qwpoke-sumgrid';
        list.forEach(function (c, k) {
          var fig = document.createElement('figure');
          fig.style.animationDelay = (k * 60) + 'ms';
          var im = document.createElement('img');
          im.src = assetUrl(c.path);
          im.onclick = function (e) {
            e.stopPropagation();
            openCardLight(c, null);
          };
          var cap = document.createElement('figcaption');
          var nameLine = document.createElement('div');
          nameLine.textContent = labelOfCard(c);
          var rarLine = document.createElement('div');
          var pill = document.createElement('span');
          pill.className = rarityClass(c.rarity);
          pill.textContent = rarityText(c.rarity, c.rarityZh);
          rarLine.appendChild(pill);
          cap.appendChild(nameLine); cap.appendChild(rarLine);
          fig.appendChild(im); fig.appendChild(cap);
          g.appendChild(fig);
        });
        var hint2 = document.createElement('div');
        hint2.className = 'qwpoke-sumhint';
        hint2.textContent = '点卡片放大看清 · 点空白处或按 Esc 收好';
        var btns = document.createElement('div');
        btns.className = 'qwpoke-lightbtns';
        var ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = '收好';
        ok.onclick = finish;
        btns.appendChild(ok);
        box.appendChild(t); box.appendChild(g); box.appendChild(hint2); box.appendChild(btns);
        ov.appendChild(box);
        ov.onclick = function (e) { if (e.target === ov || e.target === box) finish(); };
      };

      var i = 0;
      var advance = null;
      var show = function () {
        if (i >= list.length) { summary(); return; }
        var c = list[i];
        wrap.textContent = '';
        /* 直接连戴 5 张正面：原来做的"卡背→翻正面"两步节奏被用户嫌啰嗦，
           而且卡背转到正面的过渡本身也没有信息量。现在每张卡带一个入场缩放
           + 一次扫光，看着就知道"新卡来了"，然后点一下换下一张。 */
        var card = document.createElement('div');
        card.className = 'qwpoke-shot';
        var im = document.createElement('img');
        im.src = assetUrl(c.path);
        card.appendChild(im);
        wrap.appendChild(card);
        bar.textContent = '';
        var n1 = document.createElement('span');
        n1.textContent = labelOfCard(c) + ' · ';
        var p1 = document.createElement('span');
        p1.className = rarityClass(c.rarity);
        p1.textContent = rarityText(c.rarity, c.rarityZh);
        var n2 = document.createElement('span');
        n2.textContent = ' · ' + (c.setZh || c.set) + ' #' + c.no +
                         ' · 点一下' + (i + 1 >= list.length ? '看总览' : '看下一张') +
                         '（' + (i + 1) + ' / ' + list.length + '）';
        bar.appendChild(n1); bar.appendChild(p1); bar.appendChild(n2);
        advance = function () { i++; show(); };
        card.onclick = advance;
      };
      // 空白处等同于点卡：整块暗底都是「继续」，不用去瞄那张卡
      ov.onclick = function (e) { if (e.target === ov && advance) advance(); };
      onKey = function (e) {
        if (e.key === 'Escape') finish();
        else if ((e.key === 'Enter' || e.key === ' ') && advance) advance();
      };
      document.addEventListener('keydown', onKey, true);
      show();
    });
  }

  /** 选定扩充包后的完整开包流程。 */
  function runPackOpening(setId, onDone) {
    var cover = packCoverFor(setId);
    var ov = document.createElement('div');
    ov.className = 'qwpoke-open';
    var pack = document.createElement('div');
    pack.className = 'qwpoke-openpack';
    if (cover) {
      var im = document.createElement('img');
      im.src = assetUrl(cover.path);
      pack.appendChild(im);
      // 撕开的那条顶封用同一张图裁出来，视觉上才是"同一个包被撕开"
      var torn = document.createElement('div');
      torn.className = 'qwpoke-torn';
      torn.style.background = 'url("' + assetUrl(cover.path) + '") top center / 100% auto no-repeat';
      pack.appendChild(torn);
    }
    var line = document.createElement('div');
    line.className = 'qwpoke-tearline';
    pack.appendChild(line);
    var hint = document.createElement('div');
    hint.className = 'qwpoke-openhint';
    /* 撕之前先说清楚"撕的是哪个包、里面还有多少张没到手"——这是决定要不要撕的信息，
       撕完再显示就晚了。 */
    var setName = '';
    var c0 = cardsOfSet(setId);
    var leftN = c0.filter(function (c) { return !ownsCard(c.file); }).length;
    setName = (c0[0] && c0[0].setZh) || setId || '';
    hint.textContent = '「' + setName + '」还有 ' + leftN + ' 张没抽到 · 点一下撕开卡包';
    pack.appendChild(hint);
    ov.appendChild(pack);
    document.body.appendChild(ov);

    var torn2 = false;
    var onKey = function (e) {
      if (e.key !== 'Escape' || torn2) return;         // 已经撕开就没有回头路了
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      onDone([]);
    };
    document.addEventListener('keydown', onKey, true);
    pack.onclick = function () {
      if (torn2) return;
      torn2 = true;
      document.removeEventListener('keydown', onKey, true);
      pack.classList.add('tearing');
      hint.textContent = '撕开中…';
      setTimeout(function () {
        pack.classList.add('opened');
        var got = openPack(setId);
        setTimeout(function () {
          ov.remove();
          if (!got.length) { onDone([]); return; }
          revealCards(got).then(function () { onDone(got); });
        }, 620);
      }, 420);
    };
  }

  /* ---------- 卡牌灯箱 ----------
   * 点卡先看清楚，而不是直接改背景板：把"看卡"和"用卡"分成两步，误触的代价从
   * "整个界面变了" 降到 "多点一次关闭"。
   */
  function openCardLight(c, onChange) {
    var owned = ownsCard(c.file);
    var ov = document.createElement('div');
    ov.className = 'qwpoke-light';
    var im = document.createElement('img');
    im.src = assetUrl(c.path);
    var meta = document.createElement('div');
    meta.className = 'qwpoke-lightmeta';
    var l1 = document.createElement('div');
    var nm = document.createElement('span');
    nm.textContent = labelOfCard(c) + '　';
    var rp1 = document.createElement('span');
    rp1.className = rarityClass(c.rarity);
    rp1.textContent = rarityText(c.rarity, c.rarityZh);
    l1.appendChild(nm); l1.appendChild(rp1);
    var l2 = document.createElement('div');
    // 来自哪个卡包必须写出来：没抽到的那张，用户下一步就是想知道该去撕哪个包
    l2.textContent = '来自「' + (c.setZh || c.set) + '」#' + c.no +
                     (c.type ? '　' + (CARD_TYPE_ZH[c.type] || c.type) : '') +
                     (c.stage ? '　' + c.stage : '');
    meta.appendChild(l1); meta.appendChild(l2);
    if (!owned) {
      var l3 = document.createElement('div');
      l3.style.color = '#ffb4b4';
      l3.textContent = '还没抽到这张 · 去「抽卡」里撕「' + (c.setZh || c.set) + '」';
      meta.appendChild(l3);
    }
    var btns = document.createElement('div');
    btns.className = 'qwpoke-lightbtns';

    var close = document.createElement('button');
    close.textContent = '关闭';
    var shut = function () {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
    };
    var onKey = function (e) { if (e.key === 'Escape') shut(); };
    document.addEventListener('keydown', onKey, true);
    close.onclick = shut;

    if (owned) {
      var favBtn = document.createElement('button');
      var syncFav = function () {
        favBtn.textContent = (S.cardFav && S.cardFav[c.file]) ? '\u2665 已收藏' : '\u2661 收藏';
      };
      syncFav();
      favBtn.onclick = function () {
        if (!S.cardFav) S.cardFav = {};
        if (S.cardFav[c.file]) S.cardFav[c.file] = 0; else S.cardFav[c.file] = 1;
        saveSettings(); syncFav(); if (onChange) onChange();
      };

      var bgBtn = document.createElement('button');
      bgBtn.className = 'primary';
      bgBtn.textContent = '设为背景板';
      bgBtn.onclick = function () {
        S.bgFile = c.path;
        /* 卡牌是 5:7 竖图，平铺或裁切都会毁掉画面，所以标记成 contain 模式，
           applyBg 会完整居中显示整张卡，并把同一张图糊成底衬填满剩下的地方。 */
        S.bgFit = 'contain';
        saveSettings(); applyBg();
        bgBtn.textContent = '已设为背景板';
        if (onChange) onChange();
      };
      btns.appendChild(favBtn); btns.appendChild(bgBtn);
    }
    btns.appendChild(close);
    ov.appendChild(im); ov.appendChild(meta); ov.appendChild(btns);
    ov.onclick = function (e) { if (e.target === ov) shut(); };
    document.body.appendChild(ov);
  }

  /** 全卡列表：点"查看全部 X 张"后弹出，跟灯箱共用暗底样式；点每张能进单卡灯箱。 */
  function openPackCardList(setId, setZh, cards) {
    var ov = document.createElement('div');
    ov.className = 'qwpoke-open qwpoke-cardsmodal';
    var wrap = document.createElement('div');
    wrap.className = 'qwpoke-cardswrap';
    var head = document.createElement('div');
    head.className = 'qwpoke-cardshead';
    var title = document.createElement('div');
    title.textContent = '「' + setZh + '」共 ' + cards.length + ' 张卡';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.className = 'qwpoke-cardsclose';
    var shut = function () {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
    };
    var onKey = function (e) { if (e.key === 'Escape') shut(); };
    document.addEventListener('keydown', onKey, true);
    closeBtn.onclick = shut;
    head.appendChild(title); head.appendChild(closeBtn);
    var grid = document.createElement('div');
    grid.className = 'qwpoke-cardsgrid';
    cards.slice().sort(function (a, b) { return a.no - b.no; }).forEach(function (c) {
      var got2 = ownsCard(c.file);
      var cell = document.createElement('div');
      cell.className = 'qwpoke-cardscell' + (got2 ? '' : ' uncollected');
      var im = document.createElement('img');
      im.src = assetUrl(c.path);
      im.loading = 'lazy';
      cell.appendChild(im);
      var tg = document.createElement('div');
      tg.className = 'qwpoke-cardtag';
      var rp = document.createElement('span');
      rp.className = rarityClass(c.rarity);
      rp.textContent = rarityText(c.rarity, c.rarityZh);
      tg.appendChild(rp);
      var idx = document.createElement('span');
      idx.textContent = ' #' + c.no;
      tg.appendChild(idx);
      cell.appendChild(tg);
      cell.onclick = function () { openCardLight(c, null); };
      grid.appendChild(cell);
    });
    wrap.appendChild(head); wrap.appendChild(grid);
    ov.appendChild(wrap);
    ov.onclick = function (e) { if (e.target === ov) shut(); };
    document.body.appendChild(ov);
  }

  /* ---------- 登场人物 (trainer figure) ----------
   * A still portrait that stands next to the team. Deliberately not a Pet: it does
   * not walk, cannot be fed, and has no bond — making it a Pet would have dragged
   * the whole action/affection machinery into something that is pure decoration.
   * Off by default; it is an extra figure on the user's screen, not a surprise.
   */
  function trainerEntry(id) {
    for (var i = 0; i < TRAINER_LIST.length; i++) {
      if (TRAINER_LIST[i].id === id) return TRAINER_LIST[i];
    }
    return null;
  }
  function trainerFile(t) {
    if (!t || !t.files) return '';
    /* S.trainerStyle 存的是用户在「立绘」tab 里选角色时的风格 key
       (pixel / artwork / pixel-retro)，直接用它取文件 */
    var want = S.trainerStyle || S.trainerArtStyle || 'pixel';
    return t.files[want] || t.files.pixel || t.files.artwork || t.files['pixel-retro'] || '';
  }

  function removeTrainer() {
    var el = document.getElementById('qwpoke-trainer');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function applyTrainer() {
    var t = S.trainerShow ? trainerEntry(S.trainerId) : null;
    var file = trainerFile(t);
    if (!t || !file) { removeTrainer(); return; }

    var el = document.getElementById('qwpoke-trainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'qwpoke-trainer';
      el.className = 'qwpoke-trainer';
      var img = document.createElement('img');
      img.draggable = false;
      var nm = document.createElement('div');
      nm.className = 'qwpoke-tname';
      el.appendChild(img); el.appendChild(nm);
      /* Clicking cycles the style rather than opening a menu: with one figure and
         two styles a whole popup would be more clicks than the thing it changes. */
      var trDragged = false;
      el.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        trDragged = false;
        var ox = parseInt(el.style.left, 10) || 0;
        var oy = parseInt(el.style.top, 10) || 0;
        var sx = ev.clientX, sy = ev.clientY;
        var trMove = function (e) {
          var mx = e.clientX - sx, my = e.clientY - sy;
          if (Math.abs(mx) + Math.abs(my) > 3) trDragged = true;
          el.style.left = (ox + mx) + 'px';
          el.style.top = (oy + my) + 'px';
        };
        var trUp = function () {
          window.removeEventListener('mousemove', trMove, true);
          window.removeEventListener('mouseup', trUp, true);
          if (trDragged) {
            S.trainerPos = { x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) };
            saveSettings();
          }
        };
        window.addEventListener('mousemove', trMove, true);
        window.addEventListener('mouseup', trUp, true);
      });
      el.addEventListener('click', function (e) {
        if (trDragged) { trDragged = false; return; }       // 拖动不触发切换
        if (!t.files.retro || !t.files.modern) return;
        S.trainerStyle = (S.trainerStyle === 'retro') ? 'modern' : 'retro';
        saveSettings(); applyTrainer();
      });
      (document.getElementById(IDS.layer) || document.body).appendChild(el);
    }
    el.classList.toggle('retro', S.trainerStyle === 'retro');
    var img2 = el.querySelector('img');
    var want = assetUrl(file);
    if (img2.getAttribute('src') !== want) img2.setAttribute('src', want);
    el.querySelector('.qwpoke-tname').textContent = (S.trainerNick || (t.zh + (t.role ? ' · ' + t.role : '')));

    /* 双击改名：让用户给训练家起自定义称呼 */
    if (!el._nameEvt) {
      el._nameEvt = true;
      el.addEventListener('dblclick', function (e) {
        e.preventDefault(); e.stopPropagation();
        var cur = S.trainerNick || (t.zh + (t.role ? ' · ' + t.role : ''));
        askText('给这位训练家起个名字（留空恢复默认）', cur).then(function (nn) {
          if (nn === null) return;    // 取消
          S.trainerNick = nn || '';
          saveSettings();
          var nm2 = el.querySelector('.qwpoke-tname');
          if (nm2) nm2.textContent = S.trainerNick || (t.zh + (t.role ? ' · ' + t.role : ''));
        });
      });
    }

    var size = Math.max(48, Math.min(220, Number(S.trainerSize) || 96));
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    /* 如果用户拖放过训练家，就用保存的坐标；否则走默认位置逻辑 */
    if (S.trainerPos && typeof S.trainerPos.x === 'number') {
      el.style.left = S.trainerPos.x + 'px';
      el.style.top = S.trainerPos.y + 'px';
    } else if (placement() === 'right') {
      el.style.left = Math.max(0, window.innerWidth - size - RAIL_GAP) + 'px';
      el.style.top = Math.max(0, Math.round(window.innerHeight * 0.12)) + 'px';
    } else {
      el.style.left = '12px';
      el.style.top = Math.max(0, window.innerHeight - size - 6) + 'px';
    }
  }

  /* ---------- Gigantamax ----------
   * Parallel to mega, deliberately NOT merged with it: a Gigantamax form is a
   * different mechanic in canon (one battle, huge silhouette) and only 32 species
   * have a real design for it. Same reversibility and same bond gate as mega so
   * the two read consistently, but marked with a red aura instead of purple so you
   * can tell at a glance which transformation a pet is in.
   */
  function isGmax(no) { return !!(REGIONAL_FORMS[no] && REGIONAL_FORMS[no].kind === 'gmax'); }
  function gmaxBaseOf(no) { return (REGIONAL_FORMS[no] && REGIONAL_FORMS[no].base) || no; }

  function gmaxOptions(no) {
    if (isCustom(no) || isGmax(no) || isForm(no)) return [];
    var out = [];
    for (var id in REGIONAL_FORMS) {
      var r = REGIONAL_FORMS[id];
      if (r.kind === 'gmax' && r.base === no && entryOf(id)) out.push(id);
    }
    return out.sort();
  }
  /* Same three gates as mega: full bond, nothing ordinary left, no everstone.
     A species that can do both (Charizard, Venusaur…) offers both. */
  /** Why a transformation is not available yet, in the user's terms. */
  function gateReason(no) {
    var bits = [];
    if (affectionOf(no) < AFFECTION_MAX) {
      bits.push('亲密度 ' + affectionOf(no) + '/' + AFFECTION_MAX);
    }
    if (evoOptions(no).length) {
      bits.push('先走完普通进化（还能进化成' +
                evoOptions(no).map(function (x) { return labelOf(x); }).join('、') + '）');
    }
    if (hasEverstone(no)) bits.push('先收回不变之石');
    return bits.length ? bits.join(' · ') : '暂不可用';
  }

  function canGmax(no) {
    return affectionOf(no) >= AFFECTION_MAX &&
           !hasEverstone(no) &&
           evoOptions(no).length === 0 &&
           gmaxOptions(no).length > 0;
  }
  function gmaxEvolve(no, target) {
    if (!canGmax(no)) return null;
    var opts = gmaxOptions(no);
    var formId = (target && opts.indexOf(target) >= 0) ? target : opts[0];
    var idx = S.team.indexOf(no);
    if (idx < 0 || !entryOf(formId)) return null;
    S.team[idx] = formId;
    if (!S.affection) S.affection = {};
    S.affection[formId] = affectionOf(no);
    if (S.nicknames && S.nicknames[no] && !S.nicknames[formId]) S.nicknames[formId] = S.nicknames[no];
    if (S.gender && S.gender[no]) S.gender[formId] = S.gender[no];
    markUnlocked(formId);
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) { p.showTip('超极巨化！' + labelOf(formId), 5000); p.act('spin'); }
    return formId;
  }
  function gmaxRevert(no) {
    if (!isGmax(no)) return null;
    var base = gmaxBaseOf(no);
    var idx = S.team.indexOf(no);
    if (idx < 0 || !entryOf(base)) return null;
    S.team[idx] = base;
    if (!S.affection) S.affection = {};
    S.affection[base] = affectionOf(no);
    delete S.affection[no];
    if (S.nicknames && S.nicknames[no] && !S.nicknames[base]) {
      S.nicknames[base] = S.nicknames[no]; delete S.nicknames[no];
    }
    if (S.gender && S.gender[no]) { S.gender[base] = S.gender[no]; delete S.gender[no]; }
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) p.showTip('恢复原本大小了', 4000);
    return base;
  }

  /* ---------- evolution stones ----------
   * Several families only evolve with an item in canon (Vulpix needs a Fire Stone,
   * Eevee branches entirely on which stone you give it). Those evolutions are in
   * the ordinary graph, so without this they were reachable by bond alone, which
   * flattened exactly the choice that makes Eevee interesting.
   *
   * A stone is therefore an ALTERNATIVE trigger, not an extra tax: it works even
   * when the bond is not full — that is the point of an item — but an everstone
   * still refuses, because the user asked for "stop changing" and that has to win.
   */
  function stonesFor(no) {
    var out = [];
    if (isCustom(no) || isForm(no) || isGmax(no)) return out;
    for (var key in STONES_DATA) {
      var st = STONES_DATA[key];
      var target = st && st.targets && st.targets[no];
      if (!target || !entryOf(target)) continue;
      out.push({ stone: key, zh: st.zh || key, target: target });
    }
    return out;
  }
  function hasStoneEvolution(no) { return stonesFor(no).length > 0; }
  /* Which successor ids are stone-only. Used to strip them from the "bond-full
     直接进化" menu, because in the actual game Pikachu never evolves by cuddling —
     it evolves only when you give it a Thunder Stone. Offering both routes at
     once implied Raichu was reachable two ways, which is not true. */
  function stoneTargetsFrom(no) {
    var s = {};
    stonesFor(no).forEach(function (o) { s[o.target] = 1; });
    return s;
  }
  function bondEvoOptions(no) {
    var st = stoneTargetsFrom(no);
    return evoOptions(no).filter(function (n) { return !st[n]; });
  }

  function useStone(no, stoneKey) {
    if (hasEverstone(no)) return null;               // the refusal outranks the item
    /* Every route now requires a full bond — the user wanted uniform gating so a
       stone cannot short-circuit affection. This closes the Eevee case where
       giving Water Stone at bond=30 could still evolve it. */
    if (affectionOf(no) < AFFECTION_MAX) return null;
    var opt = stonesFor(no).filter(function (x) { return x.stone === stoneKey; })[0];
    if (!opt) return null;
    var idx = S.team.indexOf(no);
    if (idx < 0) return null;
    S.team[idx] = opt.target;
    /* Item evolutions are permanent like any other evolution, and they carry the
       bond forward — the pokemon you raised is still the one standing there. */
    if (!S.affection) S.affection = {};
    S.affection[opt.target] = Math.max(Number(S.affection[opt.target]) || 0, affectionOf(no));
    delete S.affection[no];
    if (!S.evolved) S.evolved = {};
    S.evolved[opt.target] = true;
    markUnlocked(opt.target);
    grantPackOnce('evo:' + opt.target, 'evolve');
    if (S.nicknames && S.nicknames[no]) { S.nicknames[opt.target] = S.nicknames[no]; delete S.nicknames[no]; }
    if (S.gender && S.gender[no]) { S.gender[opt.target] = S.gender[no]; delete S.gender[no]; }
    if (S.sizeOverrides && S.sizeOverrides[no]) { delete S.sizeOverrides[no]; }
    saveSettings();
    applyPets(); refreshGlow();
    var p = PETS[PETS.length - 1];
    if (p && p.showTip) { p.showTip('用了' + opt.zh + '，进化成' + labelOf(opt.target) + '！', 5200); p.act('spin'); }
    return opt.target;
  }

  /* ---------- agent watch ----------
   * React to the host app's own task lifecycle. The composer's submit button is
   * a send-arrow when idle and a stop-square while a run is streaming; a run that
   * pauses for the user surfaces confirm/continue buttons inside the transcript.
   * Every anchor is located defensively: if the host's DOM shifts and we can't
   * find it, detect* returns null/false and nobody gets nagged — never throw.
   */
  function findComposerSubmit() {
    var ed = document.querySelector('.chat-input-editor-text');
    if (!ed) return null;
    var edR = ed.getBoundingClientRect();
    var W = window.innerWidth || document.documentElement.clientWidth || 0;
    var btns = [].slice.call(document.querySelectorAll('button'));
    var cand = btns.filter(function (b) {
      if (!b.querySelector('svg')) return false;
      // never our own launcher (it lives at the far right of the same row)
      if (b.id === IDS.btn || b.closest('#' + IDS.btn) || b.closest('#' + IDS.layer)) return false;
      var ti = b.getAttribute('title') || '';
      if (/宝可梦|桌宠|pokepet/i.test(ti)) return false;
      var r = b.getBoundingClientRect();
      // a small round icon button on the composer's own toolbar row. The editor
      // width grows as you type, so anchor the right edge on the window, not on
      // the editor — otherwise a short input hides the send button past edR.right.
      return r.width >= 18 && r.width <= 46 && r.height >= 18 && r.height <= 46 &&
             r.top >= edR.top - 24 && r.top <= edR.bottom + 110 &&
             r.left >= edR.left - 60 && r.right <= W - 8;
    });
    if (!cand.length) return null;
    // the submit control is the right-most button on that row
    cand.sort(function (a, b) {
      return b.getBoundingClientRect().left - a.getBoundingClientRect().left;
    });
    return cand[0];
  }

  // 'running' | 'idle' | null(unknown → stay silent)
  function detectAgentState() {
    var submit = findComposerSubmit();
    if (!submit) return null;
    var svg = submit.querySelector('svg');
    if (!svg) return null;
    if (svg.querySelector('rect')) return 'running';          // stop icon drawn as <rect>
    var p = svg.querySelector('path');
    var d = (p && p.getAttribute('d')) || '';
    // observed stop-square path: "M6 5H18C18.55..V18..H6C5.44..Z" — a closed,
    // corner-rounded box. Match the box signature, not the exact coordinates.
    var box = /^M\s*6\s+5H1[0-9]/.test(d) || (/H1[0-9]/.test(d) && /V1[0-9]/.test(d) && /C/.test(d) && !/L/.test(d));
    return box ? 'running' : 'idle';
  }

  // a run paused for the user's permission surfaces BOTH an allow-ish and a
  // deny-ish button together — a pairing that is rare in ordinary content, so
  // it is a strong, low-false-positive signal. Anything less certain stays quiet.
  function detectWaiting() {
    // same container the rest of the watch uses, so a host that renames
    // .content-scroll degrades via the fallback instead of silently never
    // noticing a permission prompt again
    var scroll = findTranscript();
    if (!scroll) return false;
    var allow = /^(允许|批准|同意|接受|继续|Allow|Approve|Accept|Continue)$/i;
    var deny = /^(拒绝|不允许|取消|Deny|Reject|Decline|Cancel)$/i;
    var btns = [].slice.call(scroll.querySelectorAll('button'));
    var hasAllow = false, hasDeny = false;
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || '').trim();
      var r = btns[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (allow.test(t)) hasAllow = true;
      if (deny.test(t)) hasDeny = true;
    }
    return hasAllow && hasDeny;
  }

  /*
   * The host's send button is a stop-square only while text is actively
   * streaming; it flips back to a send-arrow during every tool call, so the
   * button alone would call a long tool run "finished". Second signal: while a
   * task is alive the transcript keeps growing (each tool block appends). So
   * "running" = stop-square OR transcript just changed, and a cheer needs BOTH
   * a send-arrow AND a transcript that has been quiet for DONE_TICKS samples.
   */
  function findTranscript() {
    var sc = document.querySelector('.content-scroll');
    if (sc) return sc;
    // fall back to the scrollable container holding the most text
    var best = null, bestLen = 0;
    var divs = [].slice.call(document.querySelectorAll('div'));
    for (var i = 0; i < divs.length; i++) {
      var e = divs[i];
      if (e.scrollHeight <= e.clientHeight + 50) continue;
      var cs = getComputedStyle(e);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      var len = (e.innerText || '').length;
      if (len > bestLen) { bestLen = len; best = e; }
    }
    return best;
  }

  function transcriptSig() {
    var t = findTranscript();
    if (!t) return null;
    // scrollHeight alone misses in-place edits, so pair it with the text length
    return t.scrollHeight + '|' + (t.innerText || '').length;
  }

  /*
   * Third signal, for the case the other two miss: a single long tool call that
   * neither streams text nor appends to the transcript (a 15-minute download).
   * The host paints a spinner on the in-flight tool block, and a settled
   * transcript has zero running animations — measured live, an idle transcript
   * reports 0 — so any running animation inside it means "still working".
   */
  function transcriptBusy() {
    var t = findTranscript();
    if (!t || !t.getAnimations) return false;
    try {
      // subtree:true walks descendants; cheap enough at a 2s cadence
      return t.getAnimations({ subtree: true }).length > 0;
    } catch (e) { return false; }
  }

  var agentTimer = null;
  var sawRunning = false;   // a task burst was observed since the last cheer
  var quietTicks = 0;       // consecutive samples with idle button + still transcript
  var cheered = false;      // already cheered for the current burst
  var lastSig = null;       // previous transcript signature
  var lastWaiting = false;
  var DONE_TICKS = 5;       // ~10s of settled idle before declaring "done"
  /*
   * The daemon watchdog re-injects whenever it finds the runtime missing, so a
   * manual inject racing that check can briefly leave two live instances (seen
   * live: 8 pets for a team of 4). Two instances would each bubble for the same
   * event, so gate the notice on a timestamp parked on `window`, which both
   * instances share — one notice per event no matter how many are running.
   */
  function noticeOnce(key, gapMs) {
    var now = Date.now();
    var w = window.__qwPokeNotice || (window.__qwPokeNotice = {});
    if (w[key] && now - w[key] < gapMs) return false;
    w[key] = now;
    return true;
  }
  function resetAgentWatch() {
    sawRunning = false; quietTicks = 0; cheered = false; lastSig = null; lastWaiting = false;
  }
  function scheduleAgentWatch() {
    if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
    resetAgentWatch();
    if (!S.agentWatch) return;
    agentTimer = setInterval(function () {
      try {
        if (!S.agentWatch || !PETS.length) return;
        var st = detectAgentState();
        var sig = transcriptSig();
        var grew = (sig !== null && lastSig !== null && sig !== lastSig);
        lastSig = sig;

        if (st === 'running' || grew || transcriptBusy()) {
          // a live task: streaming, transcript still moving, or a spinner is up
          sawRunning = true; quietTicks = 0; cheered = false;
        } else if (st === 'idle' && sawRunning) {
          quietTicks++;
          if (quietTicks >= DONE_TICKS && !cheered) {
            var p = PETS[PETS.length - 1];
            if (p && p.showTip && noticeOnce('done', 6000)) {
              // pull the wording from the same editable library as the reminders
              var lines = noticeLines('done');
              p.showTip(lines.length ? lines[Math.floor(Math.random() * lines.length)] : '任务完成啦！', 4600);
              p.act('hop');
            }
            cheered = true; sawRunning = false; quietTicks = 0;
          }
        }

        var w = detectWaiting();
        if (w && !lastWaiting) {
          var q = PETS[PETS.length - 1];
          if (q && q.showTip && noticeOnce('wait', 6000)) {
            q.showTip('需要你确认一下~', 5000); q.act('sway');
          }
        }
        lastWaiting = w;
      } catch (e) { /* host DOM shifted — stay silent */ }
    }, 2000);
  }

  /* Move the existing pets onto the current placement without rebuilding them —
     switching mode should look like they walked over, not like they blinked out. */
  function replacePets() {
    var place = placement();
    PETS.forEach(function (p, i) {
      var size = petSizeOf(p.no);
      var slot = i + 1;
      if (place === 'right') {
        p.x = Math.max(0, window.innerWidth - size - RAIL_GAP);
        var spanY = Math.max(1, window.innerHeight - size);
        p.y = Math.min(spanY, Math.round(spanY * (slot / (PETS.length + 1))));
      } else if (place === 'bottom') {
        var span = Math.max(1, window.innerWidth - size);
        p.x = Math.min(span, Math.round(span * (slot / (PETS.length + 1))));
        p.y = window.innerHeight - size - 6;
      } else {
        var saved = S.petPos && S.petPos[p.no];
        if (saved && typeof saved.x === 'number') { p.x = saved.x; p.y = saved.y; }
      }
      p.clamp(); p.draw();
    });
  }

  // ---------- pet layer ----------
  var rafId = null, lastT = 0;

  function applyPets() {
    var layer = document.getElementById(IDS.layer);
    if (!S.petsEnabled || (!POKE_LIST.length && !MY_LIST.length) || !S.team.length) {
      PETS.forEach(function (p) { p.unmount(); });
      PETS = [];
      if (layer) layer.remove();
      stopLoop();
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.id = IDS.layer;
      document.body.appendChild(layer);
    }
    // rebuild only when the roster actually changed
    var want = S.team.slice(0, MAX_TEAM).join(',');
    var have = PETS.map(function (p) { return p.no; }).join(',');
    if (want !== have) {
      PETS.forEach(function (p) { p.unmount(); });
      PETS = [];
      S.team.slice(0, MAX_TEAM).forEach(function (no, i) {
        PETS.push(new Pet(no, i).mount(layer));
      });
      // a fresh mount has no gold on it yet; re-apply so a ready pet keeps glowing
      refreshGlow();
      fxTick();
      announceVersion();
    } else {
      // roster unchanged: refresh in place (size, and sprite src for shiny toggles)
      PETS.forEach(function (p) {
        if (!p.el) return;
        var sz = petSizeOf(p.no);
        p.el.style.width = sz + 'px';
        p.el.style.height = sz + 'px';
        var ent = entryOf(p.no);
        if (ent && p.sprite) {
          var want = spriteUrl(p.no, ent.file);
          if (p.sprite.getAttribute('src') !== want) p.sprite.setAttribute('src', want);
        }
        var fs = Math.round(sz * 0.29);
        p.food.style.width = fs + 'px';
        p.food.style.height = fs + 'px';
        p.y = Math.min(p.y, window.innerHeight - sz - 4);
        p.draw();
      });
    }
    startLoop();
  }

  function startLoop() {
    if (rafId) return;
    lastT = 0;
    var step = function (t) {
      rafId = requestAnimationFrame(step);
      if (!lastT) lastT = t;
      var dt = Math.min(64, t - lastT);
      lastT = t;
      for (var i = 0; i < PETS.length; i++) PETS[i].tick(t, dt);
    };
    rafId = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function feedAll(item) {
    // Pets that jumped out to the desktop are driven by the same action, so the
    // host panel remains the only place you operate them from.
    if (S.escapedTo.length) bridgeCall('petcmd', { cmd: 'feed', item: item ? item.id : '' });
    var jobs = PETS.map(function (p, i) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          p.queue(function () { return p.feed(item); }).then(resolve, resolve);
        }, i * 220);
      });
    });
    return Promise.all(jobs);
  }

  /**
   * Feed exactly one pokemon — the one whose menu opened the picker.
   * "挑个道具喂" used to fall through to feedAll, so picking a berry for one pet
   * fed the whole team. `target` is either a Pet or the string 'desktop' (the
   * standalone pet, reachable only over the bridge).
   */
  function feedOne(target, item) {
    if (target === 'desktop') {
      bridgeCall('petcmd', { cmd: 'feed', item: item ? item.id : '' });
      return Promise.resolve();
    }
    if (!target || PETS.indexOf(target) === -1) return feedAll(item);
    return target.queue(function () { return target.feed(item); });
  }

  function feedTargetLabel(target) {
    if (!target) return '全队';
    if (target === 'desktop') return '桌面那只';
    return labelOf(target.no);
  }

  /** Same idea for actions: one click in the host window moves the desktop pet too. */
  function actAll(name) {
    if (S.escapedTo.length) bridgeCall('petcmd', { cmd: 'action', name: name || '' });
    PETS.forEach(function (p, i) {
      setTimeout(function () {
        p.act(name || randomAction());
      }, i * 160);
    });
  }

  /**
   * Run an animation with the picker out of the way.
   *
   * The panel is non-modal and by default sits clear of the pet strip, so most of
   * the time there is nothing to move. Only when the user has dragged it over the
   * pets does it need to fade out and let them through — checked by rectangle
   * overlap so feeding does not randomly blink the panel.
   */
  function peekWhile(promise) {
    var picker = document.getElementById(IDS.picker);
    var layer = document.getElementById(IDS.layer);
    var panel = picker && picker.querySelector('.qwpoke-panel');
    var overlaps = false;
    if (panel) {
      /* Measure the pets themselves, not #qwpoke-layer: that container is a
         0x0 fixed box whose children are also fixed, so its rect is always
         (0,0,0,0) and the old check could never be true. */
      var a = panel.getBoundingClientRect();
      var nodes = document.querySelectorAll('.qwpoke-pet');
      for (var pi = 0; pi < nodes.length; pi++) {
        var r = nodes[pi].getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (a.right > r.left && a.left < r.right && a.bottom > r.top && a.top < r.bottom) {
          overlaps = true; break;
        }
      }
    }
    if (!overlaps) return Promise.resolve(promise);
    if (picker) picker.classList.add('qwpoke-peek');
    if (layer) layer.classList.add('qwpoke-lift');
    var restore = function () {
      if (picker) picker.classList.remove('qwpoke-peek');
      if (layer) layer.classList.remove('qwpoke-lift');
    };
    return Promise.resolve(promise).then(restore, restore);
  }

  // ---------- launcher ----------
  function ensureButton() {
    var b = document.getElementById(IDS.btn);
    if (!b) {
      b = document.createElement('button');
      b.id = IDS.btn;
      b.type = 'button';
      b.title = '宝可梦桌宠 · 背景板 / 队伍 / 喂食';
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        /*
         * Toggle, don't reopen. openPicker() begins with closePicker() and then
         * rebuilds, so clicking the ball with the panel already up changed
         * nothing on screen and felt like a dead button. The panel is non-modal
         * on purpose (clicking outside must not dismiss it, or you could not
         * feed the pets underneath), so the ball is the natural way to close it.
         */
        if (document.getElementById(IDS.picker)) { closePicker(); return; }
        openPicker('bg');
      });
      document.body.appendChild(b);
    }
    var url = ballUrl();
    if (url) {
      var im = b.querySelector('img');
      if (!im) { im = document.createElement('img'); im.draggable = false; b.appendChild(im); }
      if (im.getAttribute('src') !== url) im.setAttribute('src', url);
    } else if (!b.textContent) {
      b.textContent = '\uD83D\uDC3E';
      b.style.background = 'var(--qwp-bg)';
      b.style.fontSize = '17px';
    }
  }

  // ---------- picker ----------
  var lazyObs = null;
  var pickerTab = null;      // which tab is showing, so a theme flip can rebuild it
  var feedTarget = null;     // who the food tab should feed; null = whole team

  /**
   * Ask for a line of text.
   *
   * The host renderer refuses window.prompt() outright — it throws
   * "prompt() is not supported" — which is why renaming a pet or setting a
   * nickname used to do nothing at all. So we draw our own dialog.
   * Resolves with the trimmed string, or null when cancelled.
   */
  function askText(title, value) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'qwpoke-ask';
      var box = document.createElement('div');
      box.className = 'qwpoke-askbox';
      var t = document.createElement('div');
      t.className = 'qwpoke-asktitle';
      t.textContent = title;
      var inp = document.createElement('input');
      inp.className = 'qwpoke-askinput';
      inp.type = 'text';
      inp.maxLength = 24;
      inp.value = value || '';
      var row = document.createElement('div');
      row.className = 'qwpoke-askrow';
      var cancel = document.createElement('button');
      cancel.className = 'qwpoke-btn2';
      cancel.textContent = '取消';
      var ok = document.createElement('button');
      ok.className = 'qwpoke-btn2 qwpoke-primary';
      ok.textContent = '确定';
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(t); box.appendChild(inp); box.appendChild(row);
      ov.appendChild(box);
      document.body.appendChild(ov);

      var done = function (val) {
        document.removeEventListener('keydown', onKey, true);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        resolve(val);
      };
      var onKey = function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); done(null); }
        else if (ev.key === 'Enter') { ev.stopPropagation(); done(inp.value.trim()); }
      };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('click', function (ev) { if (ev.target === ov) done(null); });
      cancel.onclick = function () { done(null); };
      ok.onclick = function () { done(inp.value.trim()); };
      setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 30);
    });
  }

  function closePicker() {
    var p = document.getElementById(IDS.picker);
    if (p) p.remove();
    if (lazyObs) { lazyObs.disconnect(); lazyObs = null; }
    feedTarget = null;
  }

  /**
   * Where the panel should sit when it opens. Default keeps the bottom pet strip
   * clear so you can feed while it is open; a remembered drag position wins, but
   * is always clamped back inside the viewport (window may have been resized).
   */
  function placePanel(panel) {
    var w = panel.offsetWidth || 880;
    var h = panel.offsetHeight || 560;
    var maxX = Math.max(6, window.innerWidth - w - 6);
    var maxY = Math.max(6, window.innerHeight - h - 6);
    var pos = S.panelPos;
    var x, y;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      x = pos.x; y = pos.y;
    } else {
      x = Math.round((window.innerWidth - w) / 2);
      y = 24;                                     // top-ish: pets walk at the bottom
    }
    panel.style.left = Math.round(Math.min(Math.max(6, x), maxX)) + 'px';
    panel.style.top = Math.round(Math.min(Math.max(6, y), maxY)) + 'px';
  }

  /** Drag the panel by its head, remembering where it was dropped. */
  function makePanelDraggable(panel, head) {
    head.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      // let the controls in the head behave normally
      if (ev.target.closest('button, input, select, textarea, a')) return;
      var r = panel.getBoundingClientRect();
      var offX = ev.clientX - r.left, offY = ev.clientY - r.top;
      panel.classList.add('qwpoke-moving');
      var move = function (e) {
        var maxX = Math.max(6, window.innerWidth - panel.offsetWidth - 6);
        var maxY = Math.max(6, window.innerHeight - panel.offsetHeight - 6);
        var x = Math.min(Math.max(6, e.clientX - offX), maxX);
        var y = Math.min(Math.max(6, e.clientY - offY), maxY);
        panel.style.left = Math.round(x) + 'px';
        panel.style.top = Math.round(y) + 'px';
      };
      var up = function () {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        panel.classList.remove('qwpoke-moving');
        S.panelPos = { x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) };
        saveSettings();
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      ev.preventDefault();
    });
  }

  /* ---------- pokemon list filters ----------
   * The full list is 1000+ entries in dex order. Search alone does not help when the
   * user wants "the water types from Hoenn", so types / region / generation are
   * checkbox groups combined as an intersection (groups AND, options within OR).
   * Kept in memory only: a filter is a transient way of looking, not a preference.
   */
  var FILTERS = { types: {}, regions: {}, gens: {} };

  function filterCount() {
    return Object.keys(FILTERS.types).length + Object.keys(FILTERS.regions).length +
           Object.keys(FILTERS.gens).length;
  }
  function filterActive() { return filterCount() > 0; }
  function clearFilters() { FILTERS = { types: {}, regions: {}, gens: {} }; }

  /** Does this id pass the current filters? Form ids inherit their base species. */
  function passesFilter(no) {
    if (!filterActive()) return true;
    var td = attrOf(no);
    if (!td) return false;             // photo pets have no attributes: drop while filtering
    var tk = Object.keys(FILTERS.types);
    if (tk.length && !tk.some(function (t) { return (td.types || []).indexOf(t) >= 0; })) return false;
    var rk = Object.keys(FILTERS.regions);
    if (rk.length && rk.indexOf(td.region) < 0) return false;
    var gk = Object.keys(FILTERS.gens);
    if (gk.length && gk.indexOf(String(td.gen)) < 0) return false;
    return true;
  }

  /** Header dropdown; onChange re-renders the list. */
  function buildFilterUI(onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'qwpoke-filter';
    var btn = document.createElement('button');
    var panel = null;

    var syncBtn = function () {
      var n = filterCount();
      btn.textContent = n ? ('筛选 · ' + n) : '筛选';
      btn.className = n ? 'on' : '';
    };
    syncBtn();
    var close = function () { if (panel) { panel.remove(); panel = null; } };

    var group = function (label, items, store, colorOf) {
      var g = document.createElement('div');
      g.className = 'qwpoke-fgroup';
      var t = document.createElement('div');
      t.textContent = label;
      var chips = document.createElement('div');
      chips.className = 'qwpoke-fchips';
      items.forEach(function (it) {
        var c = document.createElement('span');
        var paint = function () {
          c.className = 'qwpoke-fchip' + (store[it.key] ? ' on' : '');
          c.style.background = store[it.key] && colorOf ? colorOf(it.key) : '';
        };
        c.textContent = it.label;
        paint();
        c.onclick = function () {
          if (store[it.key]) delete store[it.key]; else store[it.key] = 1;
          paint(); syncBtn(); onChange();
        };
        chips.appendChild(c);
      });
      g.appendChild(t); g.appendChild(chips);
      return g;
    };

    btn.onclick = function (ev) {
      ev.stopPropagation();
      if (panel) { close(); return; }
      panel = document.createElement('div');
      panel.className = 'qwpoke-fpanel';
      panel.onclick = function (e) { e.stopPropagation(); };
      panel.appendChild(group('属性', Object.keys(TYPE_COLORS).map(function (t) {
        return { key: t, label: TYPE_ZH[t] || t };
      }), FILTERS.types, function (t) { return TYPE_COLORS[t]; }));
      panel.appendChild(group('地区', Object.keys(REGION_ZH).map(function (r) {
        return { key: r, label: REGION_ZH[r] };
      }), FILTERS.regions, function () { return '#4a90d9'; }));
      panel.appendChild(group('世代', [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (g) {
        return { key: String(g), label: '第 ' + g + ' 代' };
      }), FILTERS.gens, function () { return '#7a6ff0'; }));
      var clr = document.createElement('button');
      clr.className = 'qwpoke-fclear';
      clr.textContent = '清空筛选';
      clr.onclick = function () { clearFilters(); close(); syncBtn(); onChange(); };
      panel.appendChild(clr);
      wrap.appendChild(panel);
      setTimeout(function () {
        var off = function () { close(); document.removeEventListener('click', off, true); };
        document.addEventListener('click', off, true);
      }, 0);
    };

    wrap.appendChild(btn);
    wrap._sync = syncBtn;
    return wrap;
  }

  /* ---------- card album filters ----------
   * 收藏册有 3700+ 张，靠一排排分段按钮把工具条堆到半屏高，卡片反而被挤到下面看不见。
   * 所以和宝可梦一样收口成一个下拉：组之间取交集，组内取并集。
   * 默认只看已拥有 —— 刚开始只有几十张，混在几千个空位里等于没有收藏册。
   */
  var CARD_FILTERS = { rarity: {}, sets: {}, types: {}, stages: {}, favOnly: false, showMissing: false };

  function cardFilterCount() {
    return Object.keys(CARD_FILTERS.rarity).length + Object.keys(CARD_FILTERS.sets).length +
           Object.keys(CARD_FILTERS.types).length + Object.keys(CARD_FILTERS.stages).length +
           (CARD_FILTERS.favOnly ? 1 : 0) + (CARD_FILTERS.showMissing ? 1 : 0);
  }
  function clearCardFilters() {
    CARD_FILTERS = { rarity: {}, sets: {}, types: {}, stages: {}, favOnly: false, showMissing: false };
  }
  function passesCardFilter(c) {
    var owned = ownsCard(c.file);
    if (!owned && !CARD_FILTERS.showMissing) return false;
    if (CARD_FILTERS.favOnly && !(S.cardFav && S.cardFav[c.file])) return false;
    var rk = Object.keys(CARD_FILTERS.rarity);
    if (rk.length && rk.indexOf(String(c.rarity)) < 0) return false;
    var sk = Object.keys(CARD_FILTERS.sets);
    if (sk.length && sk.indexOf(String(c.set)) < 0) return false;
    var tk = Object.keys(CARD_FILTERS.types);
    if (tk.length && tk.indexOf(String(c.type || '')) < 0) return false;
    var gk = Object.keys(CARD_FILTERS.stages);
    if (gk.length && gk.indexOf(String(c.stage || '')) < 0) return false;
    return true;
  }

  /** Header dropdown for the album; onChange re-renders the grid. */
  function buildCardFilterUI(onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'qwpoke-filter';
    var btn = document.createElement('button');
    var panel = null;
    var syncBtn = function () {
      var n = cardFilterCount();
      btn.textContent = n ? ('筛选 · ' + n) : '筛选';
      btn.className = n ? 'on' : '';
    };
    syncBtn();
    var close = function () { if (panel) { panel.remove(); panel = null; } };

    var group = function (label, items, store, color) {
      var colorOf = (typeof color === 'function') ? color : function () { return color; };
      var extraClassOf = (typeof color === 'function' && color._chipClass) ? color._chipClass : null;
      var g = document.createElement('div');
      g.className = 'qwpoke-fgroup';
      var t = document.createElement('div');
      t.textContent = label;
      var chips = document.createElement('div');
      chips.className = 'qwpoke-fchips';
      items.forEach(function (it) {
        var c = document.createElement('span');
        var paint = function () {
          var extra = extraClassOf ? (' ' + extraClassOf(it.key)) : '';
          c.className = 'qwpoke-fchip' + (store[it.key] ? ' on' : '') + extra;
          c.style.background = store[it.key] ? colorOf(it.key) : '';
        };
        c.textContent = it.label;
        paint();
        c.onclick = function () {
          if (store[it.key]) delete store[it.key]; else store[it.key] = 1;
          paint(); syncBtn(); onChange();
        };
        chips.appendChild(c);
      });
      g.appendChild(t); g.appendChild(chips);
      return g;
    };
    // 两个开关也做成 chip，和其他条件长一样，用户不用分辨"哪些是筛选哪些是视图"
    var toggles = function () {
      var g = document.createElement('div');
      g.className = 'qwpoke-fgroup';
      var t = document.createElement('div');
      t.textContent = '看哪些';
      var chips = document.createElement('div');
      chips.className = 'qwpoke-fchips';
      [{ k: 'favOnly', t: '\u2665 只看收藏', c: '#e2557b' },
       { k: 'showMissing', t: '显示未拥有', c: '#5b6b8c' }].forEach(function (o) {
        var c = document.createElement('span');
        var paint = function () {
          c.className = 'qwpoke-fchip' + (CARD_FILTERS[o.k] ? ' on' : '');
          c.style.background = CARD_FILTERS[o.k] ? o.c : '';
        };
        c.textContent = o.t;
        paint();
        c.onclick = function () {
          CARD_FILTERS[o.k] = !CARD_FILTERS[o.k];
          paint(); syncBtn(); onChange();
        };
        chips.appendChild(c);
      });
      g.appendChild(t); g.appendChild(chips);
      return g;
    };

    btn.onclick = function (ev) {
      ev.stopPropagation();
      if (panel) { close(); return; }
      panel = document.createElement('div');
      panel.className = 'qwpoke-fpanel';
      panel.onclick = function (e) { e.stopPropagation(); };
      panel.appendChild(toggles());
      var rarSeen = {}, typeSeen = {}, stageSeen = {}, setSeen = {};
      CARD_LIST.forEach(function (c) {
        if (c.rarity) rarSeen[c.rarity] = 1;
        if (c.type) typeSeen[c.type] = 1;
        if (c.stage) stageSeen[c.stage] = 1;
        if (c.set) setSeen[c.set] = 1;
      });
      /* 稀有度筛选芯片保持中性配色：卡面上再用彩色 pill 也不会把下拉栏染花，
         用户反馈之前 8 档一起铺色反而看不清。 */
      panel.appendChild(group('稀有度', RARITY_ORDER.filter(function (r) { return rarSeen[r]; })
        .map(function (r) { return { key: r, label: RARITY_ZH[r] || r }; }),
        CARD_FILTERS.rarity, '#f0a020'));
      panel.appendChild(group('属性', Object.keys(typeSeen)
        .map(function (t) { return { key: t, label: CARD_TYPE_ZH[t] || t }; }),
        CARD_FILTERS.types, '#4a90d9'));
      panel.appendChild(group('阶段', Object.keys(stageSeen)
        .map(function (s) { return { key: s, label: STAGE_ZH[s] || s }; }),
        CARD_FILTERS.stages, '#7a6ff0'));
      panel.appendChild(group('扩充包', CARD_SETS.filter(function (s) { return setSeen[s.id]; })
        .map(function (s) { return { key: s.id, label: s.zh || s.id }; }),
        CARD_FILTERS.sets, '#3f9e6a'));
      var clr = document.createElement('button');
      clr.className = 'qwpoke-fclear';
      clr.textContent = '清空筛选';
      clr.onclick = function () { clearCardFilters(); close(); syncBtn(); onChange(); };
      panel.appendChild(clr);
      wrap.appendChild(panel);
      setTimeout(function () {
        var off = function () { close(); document.removeEventListener('click', off, true); };
        document.addEventListener('click', off, true);
      }, 0);
    };
    wrap.appendChild(btn);
    wrap._sync = syncBtn;
    return wrap;
  }

  function openPicker(tab, target) {
    closePicker();
    // who "挑个道具喂" should feed: the pet whose menu opened this, the desktop
    // pet, or nobody in particular (then the food tab feeds the whole team)
    feedTarget = target || null;
    var ov = document.createElement('div');
    ov.id = IDS.picker;
    var panel = document.createElement('div');
    panel.className = 'qwpoke-panel';

    var head = document.createElement('div');
    head.className = 'qwpoke-head';
    var bu = ballUrl();
    if (bu) {
      var bi = document.createElement('img');
      bi.className = 'qwpoke-ball';
      bi.src = bu; bi.draggable = false;
      head.appendChild(bi);
    }
    var title = document.createElement('b');
    title.textContent = '宝可梦桌宠';
    var tabs = document.createElement('div');
    tabs.className = 'qwpoke-tabs';
    var search = document.createElement('input');
    search.className = 'qwpoke-search';
    search.placeholder = '搜索宝可梦 / 背景板 / 头像 / 道具…';
    var xb = document.createElement('button');
    xb.className = 'qwpoke-x';
    xb.textContent = '\u2715';
    xb.onclick = closePicker;
    // filter dropdown: only meaningful on the pokemon tab, shown/hidden in render()
    var filterUI = buildFilterUI(function () { render(true); });
    // the album needs its own conditions (rarity / pack / stage), so it gets its own
    var cardFilterUI = buildCardFilterUI(function () { render(true); });
    head.appendChild(title); head.appendChild(tabs);
    head.appendChild(search); head.appendChild(filterUI);
    head.appendChild(cardFilterUI); head.appendChild(xb);

    var body = document.createElement('div');
    body.className = 'qwpoke-body';
    var hint = document.createElement('div');
    hint.className = 'qwpoke-hintbar';

    panel.appendChild(head); panel.appendChild(body); panel.appendChild(hint);
    ov.appendChild(panel);
    document.body.appendChild(ov);

    placePanel(panel);
    makePanelDraggable(panel, head);
    var onResize = function () {
      if (!panel.isConnected) { window.removeEventListener('resize', onResize); return; }
      placePanel(panel);
    };
    window.addEventListener('resize', onResize);

    var onKey = function (ev) {
      if (ev.key === 'Escape') { closePicker(); document.removeEventListener('keydown', onKey, true); }
    };
    document.addEventListener('keydown', onKey, true);

    var current = tab || 'bg';
    pickerTab = current;
    var TABS = [
      { k: 'bg', t: '背景板' },
      { k: 'team', t: '队伍' },
      { k: 'mine', t: '我的宠物' },
      { k: 'food', t: '喂食' },
      { k: 'avatar', t: '头像' },
      { k: 'pack', t: '抽卡' },
      { k: 'album', t: '收藏册' },
      { k: 'trainer', t: '立绘' },
      { k: 'set', t: '设置' }
    ];
    var tabBtns = {};
    TABS.forEach(function (d) {
      var b = document.createElement('button');
      b.className = 'qwpoke-tab';
      b.textContent = d.t;
      b.onclick = function () { current = d.k; pickerTab = d.k; render(); };
      tabs.appendChild(b);
      tabBtns[d.k] = b;
    });
    search.addEventListener('input', function () { render(true); });

    /* Store the PATH; resolve the URL only when the cell scrolls into view.
       Resolving up front is free on a local-file host, but on a ws host it would
       queue every grid item at once — the pokemon tab alone is 1000+ files, i.e.
       hundreds of MB pushed through the socket for thumbnails nobody looked at. */
    function setLazy(img, assetPath) {
      img.dataset.assetPath = assetPath;
      if (!lazyObs) {
        lazyObs = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var im = en.target;
            if (im.dataset.assetPath && !im.getAttribute('src')) {
              im.setAttribute('src', assetUrl(im.dataset.assetPath));
            }
            lazyObs.unobserve(im);
          });
        }, { root: body, rootMargin: '220px' });
      }
      lazyObs.observe(img);
    }

    function mkCell(label, file, on, onClick, kind, removable, renamable, bondFor) {
      var c = document.createElement('div');
      c.className = 'qwpoke-cell ' + kind + (on ? ' on' : '');
      var im = document.createElement('img');
      im.alt = '';
      if (file) setLazy(im, file);
      else im.style.background = 'repeating-conic-gradient(var(--qwp-cell2) 0% 25%, var(--qwp-cell) 0% 50%) 50%/14px 14px';
      var cap = document.createElement('div');
      cap.className = 'qwpoke-cap';
      cap.textContent = label;
      c.appendChild(im); c.appendChild(cap);
      /* Bond number right on the cell, so picking a team does not require hovering
         each pet in turn to find out who is close to evolving. */
      if (bondFor) {
        var pts = affectionOf(bondFor);
        var aff = document.createElement('div');
        aff.className = 'qwpoke-aff' + (pts >= AFFECTION_MAX ? ' full' : '');
        aff.textContent = pts + '/' + AFFECTION_MAX;
        c.appendChild(aff);
      }
      if (removable) {
        var rm = document.createElement('div');
        rm.className = 'qwpoke-rm';
        rm.title = '删除';
        rm.textContent = '\u2715';
        c.appendChild(rm);
      }
      if (renamable) {
        var ren = document.createElement('div');
        ren.className = 'qwpoke-ren';
        ren.title = '改名';
        ren.textContent = '\u270E';
        c.appendChild(ren);
      }
      c.onclick = onClick;
      return c;
    }
    function mkRange(label, min, max, step, val, onChange, fmt) {
      var row = document.createElement('div'); row.className = 'qwpoke-row';
      var lb = document.createElement('label'); lb.textContent = label;
      var r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val;
      var v = document.createElement('span'); v.className = 'val';
      v.textContent = fmt ? fmt(val) : val;
      r.oninput = function () {
        var nv = parseFloat(r.value);
        v.textContent = fmt ? fmt(nv) : nv;
        onChange(nv);
      };
      row.appendChild(lb); row.appendChild(r); row.appendChild(v);
      return row;
    }
    function mkSwitch(label, val, onChange) {
      var row = document.createElement('div'); row.className = 'qwpoke-row';
      var lb = document.createElement('label'); lb.textContent = label;
      var sw = document.createElement('button');
      sw.className = 'qwpoke-sw' + (val ? ' on' : '');
      sw.appendChild(document.createElement('i'));
      sw.onclick = function () {
        val = !val; sw.classList.toggle('on', val); onChange(val);
      };
      row.appendChild(lb); row.appendChild(sw);
      return row;
    }
    function mkSeg(label, opts, val, onChange) {
      var row = document.createElement('div'); row.className = 'qwpoke-row';
      var lb = document.createElement('label'); lb.textContent = label;
      var seg = document.createElement('div'); seg.className = 'qwpoke-seg';
      opts.forEach(function (o) {
        var b = document.createElement('button');
        b.textContent = o.t;
        b.className = (o.k === val ? 'on' : '');
        b._segKey = o.k;
        b.onclick = function () {
          val = o.k;
          [].slice.call(seg.children).forEach(function (c) { c.className = ''; });
          b.className = 'on';
          onChange(o.k);
        };
        seg.appendChild(b);
      });
      row.appendChild(lb); row.appendChild(seg);
      /*
       * Let the caller correct the highlight after the fact. The click marks a
       * button immediately, which is right for settings that apply at once but
       * wrong for one that first has to download ~100MB: without this the control
       * claims a style is active while the sprites have not changed.
       */
      row.setVal = function (k) {
        val = k;
        [].slice.call(seg.children).forEach(function (c) {
          c.className = (c._segKey === k ? 'on' : '');
        });
      };
      return row;
    }
    function mkBtnRow(label, text, onClick) {
      var row = document.createElement('div'); row.className = 'qwpoke-row';
      var lb = document.createElement('label'); lb.textContent = label;
      var b = document.createElement('button');
      b.className = 'qwpoke-btn2'; b.textContent = text; b.onclick = onClick;
      row.appendChild(lb); row.appendChild(b);
      return row;
    }
    function sect(text) {
      var d = document.createElement('div');
      d.className = 'qwpoke-sect';
      d.textContent = text;
      return d;
    }


    /**
     * One search box, every category. Returns how many entries in each tab match,
     * so the user can see "3 只宝可梦 / 12 张背景板" and jump straight there
     * instead of retyping the query in each tab.
     */
    function countHits(q) {
      if (!q) return null;
      var hit = function (hay) { return (hay || '').toLowerCase().indexOf(q) !== -1; };
      var c = { bg: 0, team: 0, mine: 0, food: 0, avatar: 0 };
      BG_LIST.forEach(function (b) { if (hit(b.label) || hit(b.type)) c.bg++; });
      POKE_LIST.forEach(function (p) { if (hit(p.no) || hit(p.zh) || hit(p.en)) c.team++; });
      MY_LIST.forEach(function (m) { if (hit(m.name)) c.mine++; });
      FOOD_LIST.forEach(function (f) { if (hit(f.zh) || hit(f.id)) c.food++; });
      AVATAR_LIST.forEach(function (a) { if (hit(a.label) || hit(a.type)) c.avatar++; });
      return c;
    }

    function hitsBar(q) {
      var c = countHits(q);
      if (!c) return null;
      var wrap = document.createElement('div');
      wrap.className = 'qwpoke-hits';
      var labels = { bg: '背景板', team: '宝可梦', mine: '我的宠物', food: '道具', avatar: '头像' };
      Object.keys(labels).forEach(function (k) {
        var n = c[k];
        var chip = document.createElement('button');
        chip.className = 'qwpoke-hit' + (k === current ? ' on' : '') + (n ? '' : ' zero');
        chip.textContent = labels[k] + ' ' + n;
        if (n) chip.onclick = function () { current = k; render(true); };
        wrap.appendChild(chip);
      });
      return wrap;
    }

    function render(keepScroll) {
      var st = keepScroll ? body.scrollTop : 0;
      TABS.forEach(function (d) { tabBtns[d.k].classList.toggle('on', d.k === current); });
      search.style.display = (current === 'set') ? 'none' : '';
      search.placeholder = (current === 'album') ? '搜卡名 / 卡包 / 编号 / 稀有度…'
                         : (current === 'pack') ? '搜卡包名…'
                         : '搜索宝可梦 / 背景板 / 头像 / 道具…';
      // attributes only exist for pokemon, so the filter is pointless elsewhere
      filterUI.style.display = (current === 'team') ? '' : 'none';
      cardFilterUI.style.display = (current === 'album') ? '' : 'none';
      body.innerHTML = '';
      if (lazyObs) { lazyObs.disconnect(); lazyObs = null; }
      var q = (search.value || '').trim().toLowerCase();
      if (q && current !== 'set' && current !== 'album' && current !== 'pack') {
        var bar = hitsBar(q);
        if (bar) body.appendChild(bar);
      }

      if (current === 'bg') {
        hint.textContent = '共 ' + BG_LIST.length + ' 张背景板 · 点一下即刻应用 · 浓度和范围在「设置」里调';
        var grid = document.createElement('div');
        grid.className = 'qwpoke-grid bg';
        grid.appendChild(mkCell('不用背景板', null, !S.bgFile, function () {
          S.bgFile = null; S.bgFit = ''; saveSettings(); applyBg(); render(true);
        }, 'bg'));
        BG_LIST.forEach(function (b) {
          if (q && (b.label || '').toLowerCase().indexOf(q) === -1 &&
                   (b.type || '').toLowerCase().indexOf(q) === -1) return;
          var cell = mkCell(b.label || '', b.thumb || b.file, S.bgFile === b.file, function () {
            /* bgFit 是黏的：卡牌用完留下的 contain 会让接下来选的方图也被缩在中间，
               所以选普通背景板时必须显式还原成填满。 */
            S.bgFile = b.file; S.bgFit = ''; saveSettings(); applyBg();
            [].slice.call(grid.querySelectorAll('.qwpoke-cell')).forEach(function (c) { c.classList.remove('on'); });
            cell.classList.add('on');
          }, 'bg');
          grid.appendChild(cell);
        });
        body.appendChild(grid);

      } else if (current === 'team') {
        hint.textContent = '队伍最多 ' + MAX_TEAM + ' 只 · 点成员移出 · 点下方加入 · 共 ' + POKE_LIST.length + ' 只可选';

        /* 精灵图风格 — 只影响当前队伍中正在界面上走动的宠物，不动下方网格缩略图 */
        var styleSeg = mkSeg('精灵图风格', [
          { k: 'pixel', t: '像素·会动' },
          { k: 'home', t: 'HOME 3D' },
          { k: 'artwork', t: '官方原画' }
        ], S.spriteStyle || 'pixel', function (v) {
          var say = function (t) { hint.textContent = t; };
          var repaint = function () {
            PETS.forEach(function (p) {
              var e = entryOf(p.no);
              if (e && p.sprite) p.sprite.src = spriteUrl(p.no, e.file);
            });
          };
          if (v === 'pixel' || HD_STYLES[v]) {
            S.spriteStyle = v; saveSettings();
            repaint();
            say(v === 'pixel' ? '换回像素风格，会动的那种～' : '换好啦～高清是静止画，想要会动的就切回像素');
            return;
          }
          var label = v === 'artwork' ? '官方原画' : 'HOME 3D';
          var mb = v === 'artwork' ? 78 : 124;
          if (!BRIDGE) {
            say(label + '需要先下载素材，但后台服务没在运行');
            styleSeg.setVal(S.spriteStyle || 'pixel');
            return;
          }
          styleSeg.setVal(S.spriteStyle || 'pixel');
          say('开始下载' + label + '素材（约 ' + mb + 'MB）…下载完会自动切过去');
          bridgeCall('fetchstyle', { style: v }).then(function (res) {
            if (!res || res.ok !== true) { say('下载失败，先留在当前风格'); return; }
            var stop = false;
            var tick = function () {
              if (stop) return;
              bridgeCall('stylestatus', { style: v }).then(function (st) {
                if (!st || st.ok !== true) return;
                if (st.ready) {
                  stop = true;
                  HD_STYLES[v] = true;
                  S.spriteStyle = v; saveSettings();
                  repaint();
                  styleSeg.setVal(v);
                  say(label + '换好啦～');
                  return;
                }
                if (!st.running) { stop = true; say('下载中断，再点一次继续'); return; }
                say('下载' + label + ' ' + st.files + '/' + (st.total || 1025) + '…');
                setTimeout(tick, 2000);
              });
            };
            setTimeout(tick, 1500);
          });
        });
        body.appendChild(styleSeg);
        body.appendChild(mkSwitch('异色（闪光）形态', S.shiny, function (v) {
          S.shiny = v; saveSettings();
          PETS.forEach(function (p) {
            var e = entryOf(p.no);
            if (e && p.sprite) p.sprite.src = spriteUrl(p.no, e.file);
          });
        }));

        body.appendChild(sect('我的队伍（' + S.team.length + '/' + MAX_TEAM + '）· 点一下移出'));
        if (S.team.length) {
          var tg = document.createElement('div');
          tg.className = 'qwpoke-grid team';
          S.team.forEach(function (no) {
            var e = entryOf(no);
            tg.appendChild(mkCell(labelOf(no), e ? e.file : null, true, function (ev) {
              // ✕ removes from the team; clicking the name lets you rename it
              if (ev && ev.target && ev.target.className === 'qwpoke-rm') {
                var i = S.team.indexOf(no);
                if (i >= 0) S.team.splice(i, 1);
                saveSettings(); applyPets(); render(true);
                return;
              }
              var isMine = no.indexOf('my:') === 0;
              var cur = isMine ? nameOf(no) : ((S.nicknames && S.nicknames[no]) || '');
              askText(isMine ? '给这只宠物改个名字'
                             : '给「' + nameOf(no) + '」起个昵称（留空恢复原名）', cur)
                .then(function (nn) {
                  if (nn === null) return;
                  var msg = '';
                  if (isMine) {
                    // a custom pet has no "official" name, so rename the real entry
                    if (!nn) { hint.textContent = '名字不能为空'; return; }
                    bridgeCall('renamepet', { id: no, name: nn });
                    MY_LIST = MY_LIST.map(function (x) {
                      return x.id === no ? { id: x.id, name: nn.slice(0, 24), file: x.file } : x;
                    });
                    if (S.nicknames && S.nicknames[no]) delete S.nicknames[no];
                    msg = '已改名为：' + nn.slice(0, 24);
                  } else {
                    S.nicknames = S.nicknames || {};
                    if (nn) S.nicknames[no] = nn;
                    else delete S.nicknames[no];
                    msg = nn ? ('昵称已设为：' + nn) : '已恢复原名';
                  }
                  saveSettings(); applyPets(); render(true);
                  hint.textContent = msg;      // after render, which rewrites the bar
                });
            }, 'team', true, false, no));
          });
          body.appendChild(tg);
        } else {
          body.appendChild(sect('队伍是空的，从下面挑几只吧。'));
        }
        if (S.escapedTo.length) {
          body.appendChild(sect('在桌面上：' + S.escapedTo.map(nameOf).join('、') + '（去「设置」可召回）'));
        }
        /* Add/remove by tapping a cell. Shared by the ranking row and the full
           list below, so the two cannot drift apart in behaviour. */
        var toggleTeam = function (no) {
          var i = S.team.indexOf(no);
          if (i >= 0) { S.team.splice(i, 1); }
          else {
            /* Locked forms must not be selectable, or evolution has no point: you
               could take Ninetales straight out of the list instead of raising a
               Vulpix. Refuse and say exactly what it takes. */
            if (!isUnlocked(no)) {
              hint.textContent = '「' + labelOf(no) + '」还没解锁 · ' + unlockReason(no);
              return;
            }
            if (S.team.length < MAX_TEAM) S.team.push(no);
            else { hint.textContent = '队伍满了（' + MAX_TEAM + ' 只），先移出一只再加。'; return; }
          }
          S.petsEnabled = true;
          saveSettings(); applyPets(); render(true);
        };

        /*
         * Affection ranking, between the team and the full list.
         *
         * The full list is in pokedex order across 1000+ entries, so the ones the
         * user actually raised were impossible to find again — the whole point of
         * affection is that those few are special. Ranked desc, capped, and hidden
         * while searching (a query means "find this one", not "show me my best").
         */
        if (!q) {
          /* One pet, one row. While a pokemon is mega-evolved both its base id and
             its form id carry affection, so a naive listing showed 喷火龙 and
             超级喷火龙Y as two separate entries — they are the same creature. Group
             by base identity and keep the id the user is actually holding (the one
             in the team) so the row shows the form they see walking around. */
          var byBase = {};
          Object.keys(S.affection || {}).forEach(function (no) {
            var pts = affectionOf(no);
            if (!(pts > 0) || !entryOf(no)) return;
            var base = (FORMS[no] && FORMS[no].base) || no;
            var cur = byBase[base];
            var inTeam = S.team.indexOf(no) >= 0;
            if (!cur || (inTeam && !cur.inTeam) || (inTeam === cur.inTeam && pts > cur.pts)) {
              byBase[base] = { no: no, pts: pts, inTeam: inTeam };
            }
          });
          var bonded = Object.keys(byBase).map(function (b) { return byBase[b]; })
            .sort(function (a, b) { return (b.pts - a.pts) || String(a.no).localeCompare(String(b.no)); });
          if (bonded.length) {
            var TOP_BOND = 12;
            var top = bonded.slice(0, TOP_BOND);
            body.appendChild(sect('亲密度排行 · ' + bonded.length + ' 只有羁绊' +
              (bonded.length > TOP_BOND ? '，先看前 ' + TOP_BOND + ' 只' : '') +
              ' · 点一下加入队伍'));
            var bgrid = document.createElement('div');
            bgrid.className = 'qwpoke-grid poke';
            top.forEach(function (x) {
              var e = entryOf(x.no);
              var bc = mkCell(labelOf(x.no), e ? e.file : null,
                S.team.indexOf(x.no) >= 0,
                function () { toggleTeam(x.no); },
                'poke', false, false, x.no);
              if (!isUnlocked(x.no)) {
                bc.classList.add('locked');
                bc.title = '未解锁 · ' + unlockReason(x.no);
                var bl = document.createElement('div');
                bl.className = 'qwpoke-lock';
                bl.textContent = '\uD83D\uDD12';
                bc.appendChild(bl);
              }
              bgrid.appendChild(bc);
            });
            body.appendChild(bgrid);
          }
        }

        body.appendChild(sect('全部宝可梦 · 点一下加入队伍 · \uD83D\uDD12 的是进化/超级/超极巨形态，' +
                              '要先自己养出来才能直接选（把前一形态养到亲密度 ' + AFFECTION_MAX +
                              ' 后点它进化，或用对应进化石）'));
        var g2 = document.createElement('div');
        g2.className = 'qwpoke-grid poke';
        var shown = 0;
        POKE_LIST.forEach(function (p) {
          if (q) {
            var hay = (p.no + ' ' + (p.zh || '') + ' ' + (p.en || '')).toLowerCase();
            if (hay.indexOf(q) === -1) return;
          }
          if (!passesFilter(p.no)) return;
          shown++;
          var inTeam = S.team.indexOf(p.no) >= 0;
          var pc = mkCell(p.zh || p.en || p.no, p.file, inTeam, function () {
            toggleTeam(p.no);
          }, 'poke', false, false, p.no);
          if (!isUnlocked(p.no)) {
            pc.classList.add('locked');
            pc.title = '未解锁 · ' + unlockReason(p.no);
            var lk = document.createElement('div');
            lk.className = 'qwpoke-lock';
            lk.textContent = '\uD83D\uDD12';
            pc.appendChild(lk);
          }
          g2.appendChild(pc);
        });
        body.appendChild(g2);
        if (filterActive()) {
          // without this an over-tight filter looks like a broken list
          body.appendChild(sect(shown
            ? ('筛选后 ' + shown + ' 只（共 ' + POKE_LIST.length + ' 只）')
            : '这些条件下没有宝可梦，去「筛选」里放宽一点。'));
        }

      } else if (current === 'mine') {
        hint.textContent = '用系统自带的主体分割抠图（跟「预览」的抹除背景同一个引擎），再像素化成宝可梦风格';
        if (!BRIDGE) {
          body.appendChild(sect('守护进程没在跑，暂时不能上传照片。'));
        } else {
          var top = document.createElement('div');
          top.className = 'qwpoke-row';
          var lb0 = document.createElement('label');
          lb0.textContent = '添加我的宠物';
          var up = document.createElement('button');
          up.className = 'qwpoke-btn2';
          up.textContent = '选一张照片…';
          var status = document.createElement('span');
          status.style.cssText = 'font-size:11px;color:var(--qwp-sub);';
          top.appendChild(lb0); top.appendChild(up); top.appendChild(status);
          body.appendChild(top);
          body.appendChild(sect(
            '复杂背景、沙发地毯、大头照、躺着的都能抠。抠完会缩成 64px 像素图，' +
            '既和宝可梦同风格，也顺手盖掉毛发边缘那几个不完美的像素。'
          ));

          up.onclick = function () {
            up.disabled = true;
            status.textContent = '请在弹出的窗口里选照片…';
            bridgeCall('addpet', {});
            // Step 1: the daemon picks the file and does the native cutout.
            pollJson(MY_PENDING, function (j) {
              return j && (j.state === 'ready' || j.state === 'cancelled');
            }, 200, 1200).then(function (pend) {
              if (pend.state === 'cancelled') { up.disabled = false; status.textContent = '已取消'; return null; }
              var tierText = pend.tier === 'vision' ? '系统主体分割'
                           : pend.tier === 'rembg' ? 'rembg 模型'
                           : '边缘去背（无系统抠图，效果一般）';
              status.textContent = '抠图方式：' + tierText + '，正在像素化…';
              // Step 2: pixelate on canvas, then hand the sprite back.
              return loadImage(assetUrl(pend.image)).then(function (img) {
                var dataUrl = makeSprite(img, { size: 64, floodFill: pend.needsFloodFill, outline: true });
                return bridgeCall('savepet', {
                  id: pend.id, name: pend.name, dataUrl: dataUrl,
                  src: pend.src, cut: pend.needsFloodFill ? '' : pend.image, tier: pend.tier
                }).then(function () { return pend; });
              });
            }).then(function (pend) {
              if (!pend) return;
              // Step 3: wait for it to appear in the index, then put it on the team.
              return pollJson(MY_INDEX, function (list) {
                return Array.isArray(list) && list.some(function (m) { return m.id === 'my:' + pend.id; });
              }, 40, 800).then(function (list) {
                MY_LIST = list.map(function (m) {
                  return { id: m.id, name: m.name || '我的宠物', file: m.file };
                });
                if (S.team.indexOf('my:' + pend.id) === -1 && S.team.length < MAX_TEAM) {
                  S.team.push('my:' + pend.id);
                  S.petsEnabled = true;
                  saveSettings();
                  applyPets();
                }
                up.disabled = false;
                status.textContent = '搞定：' + pend.name;
                render(true);
              });
            }).catch(function (e) {
              up.disabled = false;
              status.textContent = '失败了：' + (e && e.message ? e.message : '未知错误');
            });
          };

          if (!MY_LIST.length) {
            body.appendChild(sect('还没有自己的宠物，点上面的按钮加一只。'));
          } else {
            body.appendChild(sect('我的宠物（' + MY_LIST.length + '）· 点一下加入/移出队伍 · 左上角 ✎ 改名 · 右上角 ✕ 删除'));
            var mg = document.createElement('div');
            mg.className = 'qwpoke-grid poke';
            MY_LIST.forEach(function (m) {
              if (q && (m.name || '').toLowerCase().indexOf(q) === -1) return;
              var inTeam = S.team.indexOf(m.id) >= 0;
              var cell = mkCell(m.name, m.file, inTeam, function (ev) {
                var badge = ev && ev.target && ev.target.className;
                // ✎ renames, ✕ deletes, anywhere else toggles team membership
                if (badge === 'qwpoke-ren') {
                  ev.stopPropagation();
                  askText('给这只宠物改个名字', m.name || '').then(function (nn) {
                    if (nn === null) return;
                    if (!nn) { hint.textContent = '名字不能为空'; return; }
                    bridgeCall('renamepet', { id: m.id, name: nn });
                    m.name = nn.slice(0, 24);
                    MY_LIST = MY_LIST.map(function (x) {
                      return x.id === m.id ? { id: x.id, name: m.name, file: x.file } : x;
                    });
                    // a leftover nickname would otherwise mask the new real name
                    if (S.nicknames && S.nicknames[m.id]) { delete S.nicknames[m.id]; }
                    saveSettings();
                    applyPets();
                    render(true);
                    hint.textContent = '已改名为：' + m.name;   // after render
                  });
                  return;
                }
                if (badge === 'qwpoke-rm') {
                  ev.stopPropagation();
                  bridgeCall('delpet', { id: m.id });
                  MY_LIST = MY_LIST.filter(function (x) { return x.id !== m.id; });
                  var ti = S.team.indexOf(m.id);
                  if (ti >= 0) S.team.splice(ti, 1);
                  saveSettings(); applyPets(); render(true);
                  return;
                }
                var i = S.team.indexOf(m.id);
                if (i >= 0) S.team.splice(i, 1);
                else if (S.team.length < MAX_TEAM) S.team.push(m.id);
                else { hint.textContent = '队伍满了（' + MAX_TEAM + ' 只），先移出一只。'; return; }
                S.petsEnabled = true;
                saveSettings(); applyPets(); render(true);
              }, 'poke', true, true);
              mg.appendChild(cell);
            });
            body.appendChild(mg);
          }
        }

      } else if (current === 'avatar') {
        hint.textContent = '共 ' + AVATAR_LIST.length + ' 个 · 点一下替换' + HOST + '左下角的头像 · 第一格恢复默认';
        var types = [];
        var seenT = {};
        AVATAR_LIST.forEach(function (a) { if (!seenT[a.type]) { seenT[a.type] = 1; types.push(a.type); } });
        body.appendChild(sect('会替换' + HOST + '自己的头像（不改任何文件，卸载即还原）'));
        var ag = document.createElement('div');
        ag.className = 'qwpoke-grid poke';
        ag.appendChild(mkCell('默认头像', null, !S.avatarFile, function () {
          S.avatarFile = null; saveSettings(); applyAvatar(); render(true);
        }, 'poke'));
        AVATAR_LIST.forEach(function (a) {
          if (q && (a.label || '').toLowerCase().indexOf(q) === -1 &&
                   (a.type || '').toLowerCase().indexOf(q) === -1) return;
          var cell = mkCell(a.label || a.type, a.file, S.avatarFile === a.file, function () {
            S.avatarFile = a.file; saveSettings(); applyAvatar();
            [].slice.call(ag.querySelectorAll('.qwpoke-cell')).forEach(function (c) { c.classList.remove('on'); });
            cell.classList.add('on');
          }, 'poke');
          ag.appendChild(cell);
        });
        body.appendChild(ag);
        if (types.length) body.appendChild(sect('分类：' + types.join(' / ') + '（可在搜索框里按分类筛）'));

      } else if (current === 'pack' || current === 'album') {
        var total = CARD_LIST.length;
        var own = ownedCount();
        var favN = Object.keys(S.cardFav || {}).length;

        if (!total) {
          /* 按需下载：3700+ 张卡不该在安装时拖住第一次启动，所以这里才是入口。
             进度靠数磁盘文件，断点续传后显示的是"已经攒下的"而不是从零开始。 */
          hint.textContent = '卡牌素材未下载';
          body.appendChild(sect('卡牌素材还没下载（共 ' + (CARD_TOTAL || 3761) +
                                ' 张，安装时刻意不下，避免第一次启动等太久）'));
          var dlRow = document.createElement('div');
          dlRow.className = 'qwpoke-packbar';
          var dlBtn = document.createElement('button');
          dlBtn.className = 'qwpoke-packbtn';
          dlBtn.textContent = '下载卡牌素材';
          var dlMsg = document.createElement('span');
          dlMsg.style.cssText = 'font-size:11px;color:var(--qwp-sub);';
          var poll = null;
          var tick = function () {
            bridgeCall('cardstatus', {}).then(function (r) {
              if (!r) return;
              dlMsg.textContent = '已下载 ' + r.files + (CARD_TOTAL ? ' / ' + CARD_TOTAL : '') +
                                  (r.running ? '（进行中…）' : (r.error ? '（出错：' + r.error + '）' : '（完成）'));
              if (!r.running) {
                clearInterval(poll); poll = null;
                dlBtn.disabled = false; dlBtn.textContent = '重新检查';
                if (r.files > 0) hint.textContent = '下载完成 ' + r.files + ' 张，正在重新载入…';
              }
            });
          };
          dlBtn.onclick = function () {
            dlBtn.disabled = true; dlBtn.textContent = '下载中…';
            bridgeCall('fetchcards', {}).then(function (r) {
              if (!r || !r.ok) { dlMsg.textContent = '启动失败：' + ((r && r.error) || '守护进程没响应'); dlBtn.disabled = false; dlBtn.textContent = '下载卡牌素材'; return; }
              if (poll) clearInterval(poll);
              poll = setInterval(tick, 2000); tick();
            });
          };
          dlRow.appendChild(dlBtn); dlRow.appendChild(dlMsg);
          body.appendChild(dlRow);
          body.appendChild(sect('下载完成后会自动重新载入。抽包机制已就绪：亲密度首次满 ' +
                                AFFECTION_MAX + ' / 完成一次进化 / 每次投喂（每天上限 ' +
                                FEED_PACKS_PER_DAY + ' 包）各得 1 包，每包 ' + PACK_SIZE + ' 张不重复。'));
          tick();

        } else if (current === 'pack') {
          /* ---- 抽卡：单独一屏 ----
           * 布局遵循用户明确指示：上半屏放"当前选中包"的详情（大封面 + 撕开
           * + 侧栏放最稀有的几张作为预览，点开可看全部），下半屏才是卡包
           * grid。这样最重要的动作（撕开）永远在视线正中，切换包只影响上面
           * 的详情，下面的 grid 顺序始终稳定。
           */
          var packs = Number(S.packs) || 0;
          var missAll = total - own;
          hint.textContent = '未开卡包 ' + packs + ' 个 · 全服还差 ' + missAll +
                             ' 张没抽到 · 今天投喂还能拿 ' + feedPacksLeftToday() + ' 包';

          var setsHere = {};
          CARD_LIST.forEach(function (c) { if (c.set) setsHere[c.set] = (setsHere[c.set] || 0) + 1; });
          var zhOf = function (id) {
            var m = CARD_SETS.filter(function (x) { return x.id === id; })[0];
            if (m && m.zh) return m.zh;
            var c0 = CARD_LIST.filter(function (c) { return c.set === id; })[0];
            return (c0 && c0.setZh) || id;
          };
          /* setIds order follows CARD_SETS declaration and never changes across
             renders — so clicking a cell doesn't reshuffle the grid, only the
             top detail area updates. */
          var setIds = CARD_SETS.map(function (s) { return s.id; })
                                .filter(function (id) { return setsHere[id]; });
          Object.keys(setsHere).sort().forEach(function (id) {
            if (setIds.indexOf(id) < 0) setIds.push(id);
          });
          if (!S.packSet || setIds.indexOf(S.packSet) < 0) S.packSet = setIds[0] || '';

          // ---- 上半：当前选中包的详情 ----
          var detail = document.createElement('div');
          detail.className = 'qwpoke-packdetail';
          var leftCol = document.createElement('div');
          leftCol.className = 'qwpoke-packleftcol';
          var cover = packCoverFor(S.packSet);
          var big = document.createElement('div');
          big.className = 'qwpoke-bigcover';
          if (cover) {
            var covIm = document.createElement('img');
            covIm.src = assetUrl(cover.path);
            big.appendChild(covIm);
            if (cover.fallback) {
              big.classList.add('qwpoke-bigcover-fallback');
              var fbBadge = document.createElement('div');
              fbBadge.className = 'qwpoke-bigcover-fbbadge';
              fbBadge.textContent = '封面替代 · 组内一张卡';
              big.appendChild(fbBadge);
            }
          } else {
            big.classList.add('qwpoke-bigcover-empty');
            big.textContent = '封面暂缺';
          }
          leftCol.appendChild(big);
          var setPool = cardsOfSet(S.packSet).filter(function (c) { return !ownsCard(c.file); }).length;
          var btn = document.createElement('button');
          btn.className = 'qwpoke-packbtn';
          btn.textContent = packs > 0 ? ('撕开「' + zhOf(S.packSet) + '」（还有 ' + packs + ' 包）')
                                      : '没有卡包了';
          btn.disabled = packs <= 0 || missAll <= 0;
          btn.onclick = function () {
            closePicker();
            runPackOpening(S.packSet, function (got) {
              openPicker('pack');
              if (got && got.length) {
                var h = document.querySelector('.qwpoke-hintbar');
                if (h) h.textContent = '抽到 ' + got.length + ' 张新卡！已收集 ' +
                                       ownedCount() + '/' + total;
              }
            });
          };
          leftCol.appendChild(btn);
          var meta = document.createElement('div');
          meta.className = 'qwpoke-packmeta';
          var enOnlyNow = cardsOfSet(S.packSet).length > 0 &&
                          cardsOfSet(S.packSet).every(function (c) { return c.lang === 'en'; });
          meta.textContent = '「' + zhOf(S.packSet) + '」还有 ' + setPool + ' 张可抽 · 每包 ' +
                             PACK_SIZE + ' 张不重复' +
                             (enOnlyNow ? '\n卡图源尚未收录该扩充包的中文卡面 · 显示英文原卡' : '');
          meta.style.whiteSpace = 'pre-line';
          leftCol.appendChild(meta);
          detail.appendChild(leftCol);
          // 右侧：本包最稀有的几张 + 查看全部
          var rightCol = document.createElement('div');
          rightCol.className = 'qwpoke-packlist';
          var setCardsAll = cardsOfSet(S.packSet).slice();
          if (!setCardsAll.length) {
            var empty = document.createElement('div');
            empty.className = 'qwpoke-packlist-empty';
            empty.textContent = '这个扩充包还没下载到本地';
            rightCol.appendChild(empty);
          } else {
            /* Rarest first. tier is a numeric on the manifest so we can sort by it
               and tie-break by no. Preview shows top 6 — enough to signal "皇冠 /
               三星在这里"，不至于把网格塞满看不见封面。 */
            var top = setCardsAll.slice().sort(function (a, b) {
              return (b.tier || 0) - (a.tier || 0) || (a.no - b.no);
            }).slice(0, 6);
            top.forEach(function (c) {
              var got2 = ownsCard(c.file);
              var cc = mkCell(labelOfCard(c), c.path, false, function () {
                openCardLight(c, function () { render(true); });
              }, 'card');
              if (!got2) cc.classList.add('uncollected');
              var tg = document.createElement('div');
              tg.className = 'qwpoke-cardtag';
              var rp2 = document.createElement('span');
              rp2.className = rarityClass(c.rarity);
              rp2.textContent = rarityText(c.rarity, c.rarityZh);
              tg.appendChild(rp2);
              cc.appendChild(tg);
              rightCol.appendChild(cc);
            });
            // "查看全部" 单独一块，永远排在预览之后，占一格空位
            var seeAll = document.createElement('div');
            seeAll.className = 'qwpoke-seeall';
            seeAll.textContent = '查看全部 ' + setCardsAll.length + ' 张';
            seeAll.onclick = function () {
              openPackCardList(S.packSet, zhOf(S.packSet), setCardsAll);
            };
            rightCol.appendChild(seeAll);
          }
          detail.appendChild(rightCol);
          body.appendChild(detail);

          // ---- 下半：卡包选择 grid（顺序恒定，点击只更新上面的详情） ----
          var pg = document.createElement('div');
          pg.className = 'qwpoke-grid pack';
          var shownPacks = 0;
          setIds.forEach(function (id) {
            var zh = zhOf(id);
            if (q && (zh + ' ' + id).toLowerCase().indexOf(q) === -1) return;
            shownPacks++;
            var setCards = cardsOfSet(id);
            var left = setCards.filter(function (c) { return !ownsCard(c.file); }).length;
            var coverP = packCoverFor(id);
            /* coverP 可能是三种：
               · 真正的卡包封面（PACK_LIST 里的一项）
               · fallback: true 的卡片对象（该 set 里最稀有的一张，当替代封面）
               · null（连一张卡都没有，走斜纹占位符）
               让用户能一眼分辨"这是替代品"，加个小徽章。 */
            var cell = mkCell(zh + '\n' + (setCards.length - left) + '/' + setCards.length,
                              coverP ? coverP.path : null,
                              S.packSet === id, function () {
              S.packSet = id; saveSettings(); render(true);
            }, 'pack');
            if (!coverP) cell.classList.add('qwpoke-packnocover');
            if (coverP && coverP.fallback) {
              cell.classList.add('qwpoke-packfallback');
              var fbTag = document.createElement('div');
              fbTag.className = 'qwpoke-packfb';
              fbTag.textContent = '封面替代';
              fbTag.title = '该扩充包的封面 wiki 尚未上传，暂用组内最稀有一张卡替代';
              cell.appendChild(fbTag);
            }
            cell.querySelector('.qwpoke-cap').style.whiteSpace = 'pre-line';
            var lf = document.createElement('div');
            lf.className = 'qwpoke-packleft';
            lf.textContent = left ? ('可抽 ' + left) : '已集齐';
            cell.appendChild(lf);
            /* 若该包全部卡都是英文，标一个显眼的角标。文案是"中文卡图未收录"
               而不是"英文卡面"——中文版可能已经发行，只是 52poke 神奇宝贝百科
               还没把对应卡图上传上去，我们只能显示英文原卡。 */
            var enOnly = setCards.length > 0 && setCards.every(function (c) { return c.lang === 'en'; });
            if (enOnly) {
              var enTag = document.createElement('div');
              enTag.className = 'qwpoke-packenonly';
              enTag.textContent = '中文卡图未收录';
              enTag.title = '中文版可能已发行，但卡图源（神奇宝贝百科）暂未上传对应中文卡面，故显示英文原卡';
              cell.appendChild(enTag);
            }
            pg.appendChild(cell);
          });
          body.appendChild(pg);
          if (q && !shownPacks) body.appendChild(sect('没有匹配的扩充包，清空搜索框看全部。'));

          body.appendChild(sect('卡包来源：亲密度首次满 ' + AFFECTION_MAX + ' / 完成一次进化 / 每次投喂' +
                                '（每天上限 ' + FEED_PACKS_PER_DAY + ' 包）· 抽到的卡去「收藏册」看'));

        } else {
          /* ---- 收藏册：只管翻看 ---- */
          var shownCards = 0;
          var cg = document.createElement('div');
          cg.className = 'qwpoke-grid card';
          CARD_LIST.slice().sort(function (a, b) {
            return (a.set === b.set) ? (a.no - b.no) : String(a.set).localeCompare(String(b.set));
          }).forEach(function (c) {
            if (!passesCardFilter(c)) return;
            if (q) {
              var hay = (labelOfCard(c) + ' ' + c.label + ' ' + c.set + ' ' + (c.setZh || '') +
                         ' #' + c.no + ' ' + (RARITY_ZH[c.rarity] || '') + ' ' +
                         (CARD_TYPE_ZH[c.type] || '') + ' ' + (STAGE_ZH[c.stage] || '')).toLowerCase();
              if (hay.indexOf(q) === -1) return;
            }
            shownCards++;
            var got2 = ownsCard(c.file);
            var isFav = !!(S.cardFav && S.cardFav[c.file]);
            /* 未拥有也能点开看：想知道"我还差什么、去哪个包抽"的时候，
               一个点不开的灰格子只会让人猜。 */
            var cell = mkCell(labelOfCard(c), c.path, S.bgFile === c.path, function (ev) {
              if (ev && ev.target && ev.target.className === 'qwpoke-fav') return;   // ♥ 自己处理
              openCardLight(c, function () { render(true); });
            }, 'card');
            if (!got2) cell.classList.add('uncollected');
            var tag = document.createElement('div');
            tag.className = 'qwpoke-cardtag';
            var rp = document.createElement('span');
            rp.className = rarityClass(c.rarity);
            rp.textContent = rarityText(c.rarity, c.rarityZh);
            tag.appendChild(rp);
            var idx = document.createElement('span');
            idx.textContent = ' #' + c.no;
            tag.appendChild(idx);
            cell.appendChild(tag);
            // 来自哪个包：翻收藏册时最常问的一句，直接印在卡上省一次点击
            var src = document.createElement('div');
            src.className = 'qwpoke-cardsrc';
            src.textContent = (c.setZh || c.set) + (got2 ? '' : ' · 未拥有');
            cell.appendChild(src);
            if (got2) {
              var fav = document.createElement('div');
              fav.className = 'qwpoke-fav';
              fav.textContent = isFav ? '\u2665' : '\u2661';
              fav.onclick = function (e) {
                e.stopPropagation();
                if (!S.cardFav) S.cardFav = {};
                if (S.cardFav[c.file]) S.cardFav[c.file] = 0; else S.cardFav[c.file] = 1;
                saveSettings(); render(true);
              };
              cell.appendChild(fav);
            }
            cg.appendChild(cell);
          });
          hint.textContent = '已收集 ' + own + '/' + total + ' · 收藏 ' + favN +
                             ' · 当前显示 ' + shownCards + ' 张' +
                             (CARD_FILTERS.showMissing ? '（含未拥有）' : '（只看已拥有）');
          body.appendChild(cg);
          /* 0 张时刻意留空：图鉴一次给出 3753 个占位格既滚不到有意义的位置，
             文本 placeholder 又只是把 hintbar 的内容重复一遍。真正空的收藏册
             应该看起来就是空的——顶栏的 "0/3753" 已经说明了下一步该去哪。 */
          if (!shownCards && own > 0) {
            body.appendChild(sect('这些条件下没有卡片，去「筛选」里放宽一点，或打开「显示未拥有」。'));
          } else if (shownCards) {
            body.appendChild(sect('点卡片放大看清 · 已拥有的可以收藏或设成背景板 · 搜索框支持卡名/包名/编号'));
          }
        }

      } else if (current === 'trainer') {
        /* ---- 立绘独立页 ---- */
        hint.textContent = '共 ' + TRAINER_LIST.length + ' 位可选 · 可拖到任意位置 · 双击改名 · 大小可调';
        body.appendChild(mkSwitch('显示登场人物', !!S.trainerShow, function (v) {
          S.trainerShow = v;
          if (v && !S.trainerId && TRAINER_LIST.length) S.trainerId = TRAINER_LIST[0].id;
          saveSettings(); applyTrainer();
        }));
        if (!TRAINER_LIST.length) {
          body.appendChild(sect('还没下载训练家立绘。运行：fetch-assets.js --only trainers'));
        } else {
          /* 风格分类：像素风（Showdown 80x80）/ 官方原画（Masters 高清） / 复古像素 */
          var artStyles = [];
          var hasPixel = TRAINER_LIST.some(function (t) { return t.files && t.files.pixel; });
          var hasArtwork = TRAINER_LIST.some(function (t) { return t.files && t.files.artwork; });
          var hasRetro = TRAINER_LIST.some(function (t) { return t.files && t.files['pixel-retro']; });
          if (hasPixel) artStyles.push({ k: 'pixel', t: '像素风（' + TRAINER_LIST.filter(function(t){return t.files&&t.files.pixel;}).length + '位）' });
          if (hasArtwork) artStyles.push({ k: 'artwork', t: '官方原画（' + TRAINER_LIST.filter(function(t){return t.files&&t.files.artwork;}).length + '位）' });
          if (hasRetro) artStyles.push({ k: 'pixel-retro', t: '复古像素（' + TRAINER_LIST.filter(function(t){return t.files&&t.files['pixel-retro'];}).length + '位）' });
          if (!S.trainerArtStyle || !artStyles.some(function (s) { return s.k === S.trainerArtStyle; })) {
            S.trainerArtStyle = artStyles.length ? artStyles[0].k : 'pixel';
          }
          body.appendChild(mkSeg('立绘风格', artStyles, S.trainerArtStyle, function (v) {
            S.trainerArtStyle = v; saveSettings(); render(true);
          }));
          body.appendChild(sect('选一个风格 → 下面只列出该风格下的角色。可拖动立绘到任意位置，双击改名。'));
          var tsel = document.createElement('div');
          tsel.className = 'qwpoke-grid poke';
          var curStyle = S.trainerArtStyle || 'pixel';
          TRAINER_LIST.forEach(function (t) {
            if (!t.files || !t.files[curStyle]) return;
            var file = t.files[curStyle];
            var cap = t.zh + (t.role ? '\n' + t.role : '');
            tsel.appendChild(mkCell(cap, file, S.trainerId === t.id, function () {
              S.trainerId = t.id; S.trainerShow = true;
              S.trainerStyle = curStyle;
              saveSettings(); applyTrainer(); render(true);
            }, 'poke'));
          });
          body.appendChild(tsel);
          body.appendChild(mkRange('立绘大小', 48, 220, 2, Number(S.trainerSize) || 96, function (v) {
            S.trainerSize = v; saveSettings(); applyTrainer();
          }, function (v) { return v + 'px'; }));
        }

      } else if (current === 'fx') {
        var shapes = fxShapes();
        hint.textContent = '共 ' + FX_LIST.length + ' 张素材 / ' + shapes.length + ' 种形状 · 点一下让粒子绕着宝可梦飘';
        body.appendChild(sect('每种形状有自己的运动风格：上升 / 四散 / 飘落 / 环绕'));
        var xg = document.createElement('div');
        xg.className = 'qwpoke-grid food';
        xg.appendChild(mkCell('不放特效', null, !S.fxShape, function () {
          S.fxShape = null; saveSettings(); fxTick(); render(true);
        }, 'food'));
        shapes.forEach(function (sh) {
          if (q && sh.shape.toLowerCase().indexOf(q) === -1) return;
          var cell = mkCell(sh.shape + '（' + sh.count + '）', sh.file, S.fxShape === sh.shape, function () {
            S.fxShape = sh.shape; saveSettings(); fxTick();
            [].slice.call(xg.querySelectorAll('.qwpoke-cell')).forEach(function (c) { c.classList.remove('on'); });
            cell.classList.add('on');
          }, 'food');
          xg.appendChild(cell);
        });
        body.appendChild(xg);

      } else if (current === 'food') {
        var tgtName = feedTargetLabel(feedTarget);
        var only = !!feedTarget;
        var syncHint = function () {
          hint.textContent = only
            ? '共 ' + FOOD_LIST.length + ' 种道具 · 点一下只喂「' + tgtName + '」'
            : '共 ' + FOOD_LIST.length + ' 种道具 · 点一下喂给全队 · 也可以直接点窗口里的宝可梦随机投喂';
        };
        syncHint();
        if (!FOOD_LIST.length) {
          body.appendChild(sect('没找到食物素材（需要素材目录里的 food/ 与 foods.json）'));
        } else {
          if (feedTarget) {
            // opened from one pet's menu — feeding the whole team here was the old
            // behaviour and it surprised people, so single is the default now
            body.appendChild(mkSeg('投喂对象', [
              { k: 'one', t: '只喂 ' + tgtName },
              { k: 'all', t: '喂全队（' + PETS.length + ' 只）' }
            ], 'one', function (v) { only = (v === 'one'); syncHint(); }));
          }
          body.appendChild(sect(only
            ? '点击道具 → 只有「' + tgtName + '」会吃'
            : '点击道具 → 全队依次进食（当前 ' + PETS.length + ' 只在窗口里）'));
          var fg = document.createElement('div');
          fg.className = 'qwpoke-grid food';
          FOOD_LIST.forEach(function (f) {
            if (q && (f.zh || '').toLowerCase().indexOf(q) === -1 &&
                     (f.id || '').toLowerCase().indexOf(q) === -1) return;
            fg.appendChild(mkCell(f.zh, f.file, false, function () {
              var who = only ? tgtName : '全队';
              hint.textContent = '正在投喂 ' + who + '：' + f.zh;
              var job = only ? feedOne(feedTarget, f) : feedAll(f);
              peekWhile(job).then(function () {
                hint.textContent = '吃完了：' + f.zh + '（' + who + '）';
              });
            }, 'food'));
          });
          body.appendChild(fg);
        }

      } else {
        hint.textContent = '设置立即生效并记住 · 彻底卸载请运行 ' + (IS_WIN ? 'uninstall.ps1' : 'uninstall.sh');
        if (SKILL_INFO && SKILL_INFO.version) {
          var note = (SKILL_INFO.changelog || {})[SKILL_INFO.version] || '';
          body.appendChild(sect('当前版本 v' + SKILL_INFO.version + (note ? ' · ' + note : '')));
        }
        var themeName = themeIsDark ? '暗色' : '亮色';
        body.appendChild(sect('背景板'));
        body.appendChild(mkSeg('生效范围', [
          { k: 'window', t: '整个窗口' }, { k: 'content', t: '仅对话区' }, { k: 'sidebar', t: '仅侧边栏' }
        ], S.bgScope, function (v) { S.bgScope = v; saveSettings(); applyBg(); }));
        body.appendChild(sect('浓度按主题分别记住：当前调的是「' + themeName +
          '主题」。暗色文字接近白色、亮色文字接近黑色，两边需要的蒙层厚度不同，所以各存一套；' +
          '背景板也会自动往当前主题那一端压（暗色压暗、亮色提亮），保证文字不糊在图上。'));
        body.appendChild(mkRange('背景板浓度（' + themeName + '）', 0, 1, 0.01, bgOpacityNow(), function (v) {
          setDensity('bgOpacity', v); applyBg();
        }, function (v) { return Math.round(v * 100) + '%'; }));
        body.appendChild(mkRange('界面不透明度（' + themeName + '）', 0.35, 1, 0.01, panelAlphaNow(), function (v) {
          setDensity('panelAlpha', v); applyBg();
        }, function (v) { return Math.round(v * 100) + '%'; }));
        body.appendChild(mkRange('背景板鲜艳度（' + themeName + '）', 0.3, 1.6, 0.05, bgVividNow(), function (v) {
          setDensity('bgVivid', v); applyBg();
        }, function (v) { return Math.round(v * 100) + '%'; }));
        body.appendChild(mkRange('背景板模糊', 0, 12, 1, S.bgBlur, function (v) {
          S.bgBlur = v; saveSettings(); applyBg();
        }, function (v) { return v + 'px'; }));

        body.appendChild(sect('宝可梦'));
        body.appendChild(mkSwitch('显示宝可梦', S.petsEnabled, function (v) {
          S.petsEnabled = v; saveSettings(); applyPets();
        }));
        body.appendChild(mkSeg('宝可梦位置', [
          { k: 'bottom', t: '底部走动' },
          { k: 'right', t: '右侧走动' },
          { k: 'free', t: '拖到哪待哪' }
        ], placement(), function (v) {
          S.petPlacement = v;
          S.petWalk = (v !== 'free');      // keep the legacy flag consistent
          saveSettings();
          replacePets();
        }));
        body.appendChild(sect('底部 / 右侧会自己走来走去；「拖到哪待哪」会记住你放的位置，重启也不跑掉'));
        /* Size is per-species now, derived from the official height, so a 6.5m
           Gyarados really does tower over a 0.4m Pikachu. The user asked to keep
           that natural difference AND still be able to tune one pet by hand, so
           every team member gets its own slider and the global one stays only as
           the fallback for pets that have no height data (photo pets). */
        body.appendChild(sect('大小按官方身高自动分配。下面可单独调整每只；拖到接近默认值即恢复自动。'));
        if (S.team && S.team.length) {
          S.team.forEach(function (no) {
            var natural = SIZE_MAP[no] || S.petSize;
            var td = attrOf(no);
            var note = (td && td.height) ? '（' + (td.height / 10) + 'm · 默认 ' + natural + 'px）' : '（无身高数据）';
            body.appendChild(mkRange(labelOf(no) + note, 40, 200, 2, petSizeOf(no), function (v) {
              if (!S.sizeOverrides) S.sizeOverrides = {};
              // clear rather than store a value equal to the natural one, so a later
              // data refresh still moves this pet
              if (Math.abs(v - natural) <= 2) delete S.sizeOverrides[no];
              else S.sizeOverrides[no] = v;
              saveSettings(); applyPets();
            }, function (v) { return v + 'px'; }));
          });
        } else {
          body.appendChild(sect('队伍还是空的，先去「宝可梦」标签挑几只。'));
        }
        body.appendChild(mkRange('默认大小（照片宠物等没有身高数据的）', 48, 200, 2, S.petSize, function (v) {
          S.petSize = v; saveSettings(); applyPets();
        }, function (v) { return v + 'px'; }));
        body.appendChild(mkSwitch('待机小动作（点头/伸懒腰/打盹…）', S.idleActions, function (v) {
          S.idleActions = v; saveSettings();
        }));

        // ---- 登场人物（已搬到独立「立绘」tab） ----
        body.appendChild(sect('登场人物（训练家立绘）→ 请到「立绘」标签页选择'));

        // ---- 关怀提醒 ----
        body.appendChild(mkSwitch('关怀提醒（喝水 / 久坐 / 护眼 · 吃饭 · 该睡了）', !!S.careBubbles, function (v) {
          S.careBubbles = v; saveSettings();
          scheduleCare();                 // re-arm now so it works without re-inject
          scheduleClockNotices();
          renderCareRows();
        }));
        var careBox = document.createElement('div');
        body.appendChild(careBox);
        /* One textarea per trigger, picked with a segment control. A single box
           for everything would be unusable now: "该睡了" must not turn up at
           11am, so the copy has to stay attached to the thing that fires it. */
        var NOTICE_TABS = [
          { k: 'water', t: '喝水', note: '按下面的提醒间隔轮流触发（喝水 → 久坐 → 护眼）' },
          { k: 'sit', t: '久坐', note: '按提醒间隔轮流触发' },
          { k: 'eyes', t: '护眼', note: '按提醒间隔轮流触发' },
          { k: 'lunch', t: '午餐', note: '每天 12 点整（读系统时间，只提醒一次）' },
          { k: 'dinner', t: '晚餐', note: '每天 18 点整（读系统时间，只提醒一次）' },
          { k: 'sleepEarly', t: '该睡了·20-21点', note: '20 / 21 点各提醒一次，语气最轻' },
          { k: 'sleepLate', t: '该睡了·22-23点', note: '22 / 23 点各提醒一次，语气加重' },
          { k: 'sleepOvernight', t: '该睡了·0点后', note: '0 点后每个整点提醒一次，语气最重' },
          { k: 'done', t: '任务完成', note: '需同时打开「任务提醒」，任务跑完时说' },
          { k: 'start', t: '开工', note: '每天第一次打开时说一次' }
        ];
        var noticeTab = 'water';
        function renderCareRows() {
          careBox.innerHTML = '';
          if (!S.careBubbles) return;
          careBox.appendChild(mkRange('提醒间隔', 5, 120, 5, Number(S.careMinutes) || 45, function (v) {
            S.careMinutes = v; saveSettings(); scheduleCare();
          }, function (v) { return v + ' 分钟'; }));
          careBox.appendChild(sect('只作用于喝水 / 久坐 / 护眼；吃饭与该睡了按系统时间到点触发'));

          var seg = mkSeg('文案分类', NOTICE_TABS.map(function (t) { return { k: t.k, t: t.t }; }),
            noticeTab, function (v) { noticeTab = v; drawBox(); });
          careBox.appendChild(seg);

          var box = document.createElement('div');
          careBox.appendChild(box);
          function drawBox() {
            box.innerHTML = '';
            var meta = NOTICE_TABS.filter(function (t) { return t.k === noticeTab; })[0] || NOTICE_TABS[0];
            var row = document.createElement('div');
            row.className = 'qwpoke-row';
            row.style.alignItems = 'flex-start';
            var lb = document.createElement('label');
            lb.textContent = meta.t + ' 文案';
            var wrap = document.createElement('div');
            wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:4px;';
            var ta = document.createElement('textarea');
            ta.value = noticeLines(noticeTab).join('\n');
            ta.rows = 6;
            ta.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical;border-radius:8px;' +
              'border:1px solid var(--qwp-line);background:var(--qwp-chip);color:var(--qwp-fg);' +
              'padding:6px 8px;font:12px inherit;line-height:1.5;';
            ta.onblur = function () {
              var lines = ta.value.split('\n').map(function (s) { return s.trim(); })
                .filter(function (s) { return s; });
              if (!S.noticeMsgs || typeof S.noticeMsgs !== 'object') S.noticeMsgs = {};
              /* Emptying a box would silently switch that reminder off with no
                 way to tell why, so an empty edit restores the shipped copy. */
              S.noticeMsgs[noticeTab] = lines.length ? lines : DEFAULTS.noticeMsgs[noticeTab].slice();
              saveSettings();
              if (!lines.length) ta.value = noticeLines(noticeTab).join('\n');
            };
            var tip = document.createElement('div');
            tip.style.cssText = 'font-size:11px;color:var(--qwp-fg2);';
            tip.textContent = meta.note + ' · 每行一句，随机挑一句。改完点别处即保存；清空则恢复默认。';
            wrap.appendChild(ta); wrap.appendChild(tip);
            row.appendChild(lb); row.appendChild(wrap);
            box.appendChild(row);
          }
          drawBox();
        }
        renderCareRows();

        // ---- 任务提醒（盯 Agent 状态）----
        body.appendChild(mkSwitch('任务提醒（跑完报喜 / 等确认时举手）', !!S.agentWatch, function (v) {
          S.agentWatch = v; saveSettings();
          scheduleAgentWatch();           // re-arm now so it works without re-inject
        }));

        /*
         * External reminders. Nothing here polls anything: the switch decides
         * whether the pet is willing to relay a notice that some other program on
         * this machine already pushed to the local bridge (e.g. a scheduled task
         * that read DingTalk todos). Kept next to the other notice switches so
         * all of "when may the pet talk to me" lives in one place.
         */
        body.appendChild(mkSwitch('外部提醒（转达本机推送来的消息，如钉钉待办）', S.extNotices !== false, function (v) {
          S.extNotices = v; saveSettings();
        }));

        body.appendChild(mkBtnRow('喂食全队', '随机投喂', function () {
          hint.textContent = '投喂中…（面板先让开）';
          peekWhile(feedAll(null)).then(function () { hint.textContent = '吃完了'; });
        }));

        body.appendChild(sect('桌面模式'));
        /*
         * When desktop mode cannot work, say why and what the user can do —
         * then stop. Rendering the switch, the status row and the two buttons
         * anyway meant four controls that do nothing, and the status row even
         * claimed "找不到桌宠脚本，重装一次技能即可", which on macOS is false: the
         * blocker is Apple notarisation, and reinstalling changes nothing.
         * The recall button is the one exception below — a pet stranded on the
         * desktop by an earlier state must always have a way home.
         */
        if (!DESKTOP_READY) {
          body.appendChild(sect(DESKTOP_NOTE || DESKTOP_REASONS[DESKTOP_REASON] || DESKTOP_REASONS.unknown));
          if (S.escapedTo.length) {
            body.appendChild(mkBtnRow('召回到' + HOST, '把桌面上的收回窗口', function () {
              recallFromDesktop();
              hint.textContent = '已召回到窗口内';
              render(true);
            }));
          }
        } else {
        body.appendChild(mkSwitch('拖到边缘自动逃逸到桌面', S.escapeToDesktop, function (v) {
          S.escapeToDesktop = v; saveSettings();
        }));
        /* The desktop pet runs on OS-native scripting, so there is nothing to
           install — just report whether the daemon can find the script. */
        (function () {
          var row = mkBtnRow('桌面宠物', '检查中…', function () {});
          body.appendChild(row);
          var label = row.querySelector('label');
          var btn = row.querySelector('button');
          btn.disabled = true;
          bridgeCall('desktopstatus', {}).then(function (st) {
            if (!st) { label.textContent = '守护进程未运行'; btn.textContent = '不可用'; return; }
            if (!st.available) {
              label.textContent = '找不到桌宠脚本，重装一次技能即可';
              btn.textContent = '缺文件';
              return;
            }
            label.textContent = st.running ? '正在桌面上溜达' : '随时可用 · 拖宠物到窗口边缘即可';
            btn.textContent = st.running ? '运行中' : '就绪';
          });
        })();

        body.appendChild(mkBtnRow('放到桌面', DESKTOP_READY ? '让队长去桌面' : '需要桌面宠物程序', function () {
          if (!BRIDGE) { hint.textContent = '桌面模式不可用（守护进程未运行）'; return; }
          if (!DESKTOP_READY) { hint.textContent = DESKTOP_NOTE; return; }
          if (!PETS.length) { hint.textContent = '窗口里没有宠物可以送出去'; return; }
          // escapeToDesktop only removes the pet once the daemon confirms the app
          // started, so report afterwards instead of assuming success
          var before = S.team.length;
          hint.textContent = '正在送去桌面…';
          escapeToDesktop(PETS[0]);
          setTimeout(function () {
            hint.textContent = S.team.length < before ? '已在桌面启动' : '桌面程序没起来，宠物留在窗口里';
            render(true);
          }, 1600);
        }));
        body.appendChild(mkBtnRow('召回到' + HOST,
          S.escapedTo.length ? '把桌面的收回窗口' : '桌面上没有宠物', function () {
            if (!S.escapedTo.length) { hint.textContent = '桌面上没有出去的宠物'; return; }
            recallFromDesktop();
            hint.textContent = '已召回到窗口内';
            render(true);
          }));
        if (S.escapedTo.length) {
          // The desktop pet has no menu of its own for these — it is operated
          // from here, so both places never drift apart.
          body.appendChild(sect('桌面上的：' + S.escapedTo.map(labelOf).join('、')));
          body.appendChild(mkBtnRow('喂桌面上的宠物', '随机道具，桌面上那只也吃', function () {
            bridgeCall('petcmd', { cmd: 'feed', item: '' });
            hint.textContent = '已让桌面上的宠物吃东西';
          }));
          body.appendChild(mkBtnRow('让它换个动作', '桌面上那只做个小动作', function () {
            bridgeCall('petcmd', { cmd: 'action', name: '' });
            hint.textContent = '已让桌面上的宠物换个动作';
          }));
        }
        }   // end of the DESKTOP_READY branch

        if (BALL_LIST.length) {
          body.appendChild(sect('入口图标（精灵球）· 共 ' + BALL_LIST.length + ' 款'));
          var bg2 = document.createElement('div');
          bg2.className = 'qwpoke-grid food';
          BALL_LIST.forEach(function (b) {
            bg2.appendChild(mkCell(b.zh || b.id, b.file, S.ballId === b.id, function () {
              S.ballId = b.id; saveSettings(); ensureButton(); render(true);
            }, 'food'));
          });
          body.appendChild(bg2);
        }
      }
      body.scrollTop = st;
    }

    render();
  }

  // ---------- keepalive ----------
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { scheduled = false; ensureAll(); });
    });
  }

  function ensureAll() {
    if (!document.body) return;
    if (!document.getElementById(IDS.style)) ensureStyle();
    applyTheme();
    applyBg();
    applyPets();
    ensureButton();
    applyAvatar();
    applyTrainer();
  }

  function boot() {
    // ws hosts only: watch for placeholder URLs and swap in blob: URLs as bytes
    // stream in. No-op on a local-file host.
    startAssetFixup();
    // top up from the shared on-disk copy before the first paint, so a host that
    // has never seen these pets still shows their real affection and background.
    try { pullGrowth(); } catch (e) {}
    // Keep hosts converged after desktop feeding or edits made in another workspace.
    // Re-injection must replace, not stack, these hooks.
    try {
      if (window.__qwPokeGrowthFocus) window.removeEventListener('focus', window.__qwPokeGrowthFocus);
      if (window.__qwPokeGrowthTimer) clearInterval(window.__qwPokeGrowthTimer);
      window.__qwPokeGrowthFocus = function () { try { pullGrowth(); } catch (e) {} };
      window.addEventListener('focus', window.__qwPokeGrowthFocus);
      window.__qwPokeGrowthTimer = setInterval(function () {
        try { pullGrowth(); } catch (e) {}
      }, 30000);
    } catch (e) {}
    ensureStyle();
    applyTheme();
    ensureAll();
    fxTick();
    scheduleIdle();
    scheduleCare();
    scheduleClockNotices();
    greetOnce();
    scheduleAgentWatch();
    scheduleCompanion();
    refreshGlow();
    if (window.__qwPokeObs) window.__qwPokeObs.disconnect();
    window.__qwPokeObs = new MutationObserver(function () { schedule(); });
    window.__qwPokeObs.observe(document.body, { childList: true, subtree: false });
    // Theme switches only rewrite data-theme on <html>, so watch just that
    // attribute — watching class/style here would fire on our own writes.
    if (window.__qwPokeThemeObs) window.__qwPokeThemeObs.disconnect();
    window.__qwPokeThemeObs = new MutationObserver(function () {
      if (!applyTheme()) return;
      if (S.bgFile) { applyBg(); tagSurfaces(); }
      // the density sliders are theme-specific, so a live panel must be redrawn
      if (document.getElementById(IDS.picker)) {
        var keepTarget = feedTarget;   // closePicker() inside openPicker clears it
        openPicker(pickerTab || 'bg', keepTarget);
      }
    });
    window.__qwPokeThemeObs.observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
    if (window.__qwPokeResize) window.removeEventListener('resize', window.__qwPokeResize);
    window.__qwPokeResize = function () {
      applyBg(); applyPets(); applyTrainer();
      /* Resizing used to leave pets outside the viewport: applyPets() only rebuilds
         when the roster changed, and a walking pet only corrects the axis it walks
         along. Clamp every pet and re-pin the right rail here. */
      PETS.forEach(function (p) {
        if (placement() === 'right') p.x = Math.max(0, window.innerWidth - petSizeOf(p.no) - RAIL_GAP);
        p.clamp(); p.draw();
      });
    };
    window.addEventListener('resize', window.__qwPokeResize);
    /*
     * There used to be a focus poller here that faded the board and the pets out
     * whenever another window came in front. It was a fix for the wrong problem:
     * documents opened in the host's preview window were unreadable because the
     * skin was being INJECTED into that window and painting over the text, not
     * because anything showed through from behind. findTarget now keeps us out
     * of those windows, and documents render perfectly with the board at full
     * strength — so the dimming bought nothing and made the whole app visibly
     * change colour every time a document opened. Don't bring it back.
     */
    if (window.__qwPokeFocusTimer) clearInterval(window.__qwPokeFocusTimer);
    // Navigating between 对话 / 新任务 / 技能 / 设置 swaps deep subtrees, which the
    // body-level observer never sees. Re-sampling is cheap, so just do it on a timer.
    if (window.__qwPokeSurfaceTimer) clearInterval(window.__qwPokeSurfaceTimer);
    window.__qwPokeSurfaceTimer = setInterval(function () {
      // safety net: OS-level flips and custom themes that don't touch data-theme
      if (applyTheme() && S.bgFile) applyBg();
      if (S.bgFile) tagSurfaces();
    }, 1200);
  }

  function destroy() {
    try { if (window.__qwPokeObs) window.__qwPokeObs.disconnect(); } catch (e) {}
    try { if (window.__qwPokeThemeObs) window.__qwPokeThemeObs.disconnect(); } catch (e) {}
    if (window.__qwPokeResize) window.removeEventListener('resize', window.__qwPokeResize);
    stopLoop();
    if (fxTimer) { clearInterval(fxTimer); fxTimer = null; }
    if (window.__qwPokeSurfaceTimer) { clearInterval(window.__qwPokeSurfaceTimer); window.__qwPokeSurfaceTimer = null; }
    if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
    resetAgentWatch();
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (companionTimer) { clearInterval(companionTimer); companionTimer = null; }
    clearTimeout(careTimer);
    clearTimeout(idleTimer);
    S.avatarFile = null; applyAvatar();
    untagSurfaces();
    PETS.forEach(function (p) { p.unmount(); });
    PETS = [];
    closePicker();
    closePetPop();
    var ask = document.querySelector('.qwpoke-ask');
    if (ask && ask.parentNode) ask.parentNode.removeChild(ask);
    [IDS.style, IDS.bg, IDS.btn, IDS.layer].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.remove();
    });
    var root = document.documentElement;
    root.classList.remove('qwpoke-board', 'qwpoke-dark');
    root.style.removeProperty('--qwpoke-veil');
    root.style.removeProperty('--qwpoke-panel');
    root.style.removeProperty('--qwpoke-surface');
    root.style.removeProperty('--qwpoke-veil-rgb');
    themeIsDark = null;
    /* ws hosts: drop the asset machinery too. Re-injection happens on every host
       reload, so leaving observers and object URLs behind would pile up. */
    try { removeTrainer(); } catch (e) {}
    try { if (assetObserver) { assetObserver.disconnect(); assetObserver = null; } } catch (e) {}
    try { if (wsSock) { wsSock.close(); wsSock = null; } } catch (e) {}
    /* http hosts: the relay iframe is ours too; leaving it behind piles up a
       hidden frame per re-injection (observed: two after one daemon restart). */
    try {
      if (relayFrame) { relayFrame.remove(); relayFrame = null; }
      relayReady = null; relayPending = {};
    } catch (e) {}
    try {
      Object.keys(assetBlob).forEach(function (k) { URL.revokeObjectURL(assetBlob[k]); });
      assetBlob = {}; assetWaiting = {}; wsPending = {};
    } catch (e) {}
    try {
      if (window.__qwPokeGrowthFocus) window.removeEventListener('focus', window.__qwPokeGrowthFocus);
      if (window.__qwPokeGrowthTimer) clearInterval(window.__qwPokeGrowthTimer);
      window.__qwPokeGrowthFocus = null;
      window.__qwPokeGrowthTimer = null;
    } catch (e) {}
    delete window.__qwPoke;
  }

  window.__qwPoke = {
    version: 2,
    /* Which asset channel this host ended up on, so a self-check can tell a
       CSP-locked host (ws + blob:) from a local-file host without guessing. */
    transport: function () {
      return { mode: TRANSPORT, wsUrl: WS_URL, cached: Object.keys(assetBlob).length,
               connected: !!(wsSock && wsSock.readyState === 1) };
    },
    settings: function () { return S; },
    set: function (patch) {
      var fxChanged = Object.prototype.hasOwnProperty.call(patch, 'fxShape');
      var has = function (k) { return Object.prototype.hasOwnProperty.call(patch, k); };
      var careChanged = has('careBubbles') || has('careMinutes');
      var watchChanged = has('agentWatch');
      for (var k in patch) S[k] = patch[k];
      if (S.team) S.team = S.team.slice(0, MAX_TEAM);
      saveSettings(); ensureAll();
      if (fxChanged) fxTick();
      // the timers are armed at boot, so a live toggle has to re-arm them here
      // too — otherwise flipping these through the API silently does nothing
      if (careChanged) scheduleCare();
      if (careChanged) scheduleClockNotices();
      if (watchChanged) scheduleAgentWatch();
      /* The gold states are painted from these four; without this a patch that
         adds an everstone left the pet still glowing "click me to evolve" even
         though evolution had just been refused. */
      if (has('affection') || has('everstone') || has('evolved') || has('team')) refreshGlow();
      // switching placement through the API must move them too, not just save it
      if (has('petPlacement') || has('petPos') || has('petSize')) replacePets();
      return S;
    },
    open: openPicker,
    /*
     * Show a reminder pushed in from outside (daemon `POST /notify` relays here).
     * The pet is deliberately only a sink: it never queries DingTalk or anything
     * else itself. That is not a simplification — `dws` only runs for real inside
     * the host's own shell tool (a background daemon gets a
     * `pending-post-tool-use` placeholder back), so the fetching has to live in a
     * scheduled host task which then pushes the finished text here.
     * Returns a string so the caller can log why nothing appeared.
     */
    notify: function (text, opts) {
      var t = String(text == null ? '' : text).trim();
      if (!t) return 'empty';
      if (!S.extNotices) return 'disabled';
      if (!PETS.length) return 'no pets';
      // keep the bubble readable — it is one line above a 96px sprite
      if (t.length > 60) t = t.slice(0, 59) + '…';
      var key = (opts && opts.key) || ('ext:' + t);
      // same reminder pushed twice (retry, or two daemon instances) → show once
      if (!noticeOnce(key, (opts && opts.gapMs) || 60000)) return 'deduped';
      var p = PETS[PETS.length - 1];
      if (!p || !p.showTip) return 'no pet';
      p.showTip(t, (opts && opts.ms) || 6000);
      p.act((opts && opts.act) || 'nod');
      return 'shown';
    },
    /* Read the agent-watch inputs without waiting for a bubble. Used by the
       headless self-check, and the fastest way to tell whether the host's DOM
       still matches our anchors on a machine we cannot inspect by hand. */
    /* Bond + evolution state, for the headless self-check and for answering
       "why is my pokemon glowing / not glowing" without guesswork. */
    bond: function (no) {
      var one = function (id) {
        return { pts: affectionOf(id), level: affectionName(id), next: evoOptions(id),
                 everstone: hasEverstone(id), evolved: isEvolved(id), ready: canEvolve(id),
                 isForm: isForm(id), base: baseOf(id), mega: megaOptions(id), canMega: canMega(id) };
      };
      if (no) return one(no);
      var out = {};
      S.team.forEach(function (id) { out[id] = one(id); });
      return out;
    },
    /* Test hooks. Deliberately explicit rather than letting a test poke S
       directly, so the same clamping and glow refresh run as in real use. */
    setBond: function (no, pts) {
      if (!S.affection) S.affection = {};
      S.affection[no] = Math.max(0, Math.min(AFFECTION_MAX, Number(pts) || 0));
      saveSettings(); refreshGlow();
      return affectionOf(no);
    },
    /* The daemon calls this on its own 5s watchdog. Renderer timers are heavily
       throttled while a workspace is covered or in the background, so relying on
       setInterval(30000) alone made cross-host affection sync stall indefinitely
       until the user focused the window. The daemon is not renderer-throttled. */
    sync: pullGrowth,
    evolve: function (no, target) { return evolvePet(no, target); },
    mega: function (no, target) { return megaEvolve(no, target); },
    unmega: function (no) { return megaRevert(no); },
    companionTick: companionTick,
    agentProbe: function () {
      return { state: detectAgentState(), waiting: detectWaiting(),
               busy: transcriptBusy(), sig: transcriptSig(),
               submit: !!findComposerSubmit(), transcript: !!findTranscript() };
    },
    feed: function (foodId) {
      var item = null;
      if (foodId) for (var i = 0; i < FOOD_LIST.length; i++) if (FOOD_LIST[i].id === foodId) item = FOOD_LIST[i];
      peekWhile(feedAll(item));
      return 'feeding ' + PETS.length + ' pokemon';
    },
    recall: recallFromDesktop,
    makeSprite: makeSprite,      // exposed so the pipeline can be tested headlessly
    pets: function () { return PETS.map(function (p) { return p.no; }); },
    destroy: destroy,
    counts: { bg: BG_LIST.length, poke: POKE_LIST.length, food: FOOD_LIST.length,
              ball: BALL_LIST.length, mine: MY_LIST.length }
  };

  boot();
  return 'qwpoke v3 ok bg=' + BG_LIST.length + ' poke=' + POKE_LIST.length +
         ' food=' + FOOD_LIST.length + ' ball=' + BALL_LIST.length +
         ' mine=' + MY_LIST.length + ' team=' + S.team.length;
})();
