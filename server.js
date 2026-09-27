/*
 * 文洛 · 文章竞赛社区 —— 后端服务
 * 多账号 / 文章与帖子审核 / 比赛创建与报名 / 文件投稿 / 排行榜
 * 数据存储：data/db.json（轻量 JSON 库，免安装数据库）
 */
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
// Render 持久化存储路径
const RENDER_DISK_PATH = process.env.RENDER_DISK_PATH || '';
const DATA_DIR = RENDER_DISK_PATH ? path.join(RENDER_DISK_PATH, 'data') : path.join(ROOT, 'data');
const UPLOAD_DIR = RENDER_DISK_PATH ? path.join(RENDER_DISK_PATH, 'uploads') : path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

for (const d of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ---------------- 密码 ---------------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  const h = crypto.scryptSync(String(password), user.salt, 64);
  const ref = Buffer.from(user.hash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}

/* ---------------- 数据库 ---------------- */
let db;
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
  const now = Date.now();
  const admin = Object.assign(
    {
      id: 'u_admin', username: 'admin', nickname: '站务管理员', role: 'admin',
      bio: '本站管理员，负责文章、帖子与投稿审核。', createdAt: now
    },
    hashPassword('admin123')
  );
  db = { users: [admin], articles: [], posts: [], contests: [], files: [], messages: [], problems: [], practices: [] };

  // 演示数据：一篇已通过的文章 + 一个进行中的比赛 + 一个帖子
  db.articles.push({
    id: 'a_welcome', authorId: 'u_admin', title: '欢迎来到文洛 · 文章竞赛社区',
    content: '## 这里可以做什么\n\n- **写文章**：点击侧边栏「我的文章」或主页「立即开始创作」，提交后由管理员审核，通过后进入文章库。\n- **逛论坛**：在「论坛广场」发帖交流，帖子同样需要审核。\n- **打比赛**：管理员会在「比赛广场」创建比赛，欢迎报名参加。\n- **文件投稿**：有文档想分享？通过「文件投稿」上传，审核通过后归档。\n\n## 社区公约\n\n1. 保持友善，尊重原创。\n2. 文章支持 `Markdown` 基础语法：**加粗**、`代码`、标题等。\n3. 违规内容将被拒绝并记录。\n\n祝大家玩得开心！',
    status: 'approved', views: 128, likes: [], createdAt: now - 86400000, reviewedAt: now - 86000000
  });
  db.posts.push({
    id: 'p_hello', authorId: 'u_admin', title: '【置顶】新人报到帖',
    content: '新来的同学在这里打个招呼吧！介绍一下自己擅长的领域 ~',
    status: 'approved', createdAt: now - 43200000, comments: []
  });
  db.contests.push({
    id: 'c_demo', title: '第一届「文洛杯」短文创作赛',
    description: '## 比赛说明\n\n围绕主题「**代码与生活**」写一篇不超过 2000 字的短文。\n\n- 参赛作品请通过「我的文章 → 写文章」提交，标题前缀【文洛杯】。\n- 评审标准：立意 40%、文笔 40%、创意 20%。\n\n期待大家的作品！',
    startTime: now - 3600000, endTime: now + 7 * 86400000,
    createdBy: 'u_admin', createdAt: now - 7200000, participants: []
  });
  saveDBNow();
  }
  // 兼容旧数据：补充新字段
  db.messages = db.messages || [];
  for (const u of db.users) u.following = u.following || [];
  if (!Array.isArray(db.problems)) { db.problems = []; seedProblems(); }
  for (const p of db.problems) if (!p.status) p.status = 'approved';
  db.practices = db.practices || [];
  for (const a of db.articles) if (!a.category) a.category = '其他';
  for (const p of db.posts) if (!p.category) p.category = '其他';
  for (const c of db.contests) {
    c.submissions = c.submissions || [];
    if (!(c.problems || []).length) {
      // 旧版比赛（无题目）默认补三道题，保持可用
      c.problems = [
        { id: uid('q'), title: '主题创作', content: '围绕比赛主题，完成一篇原创作品。', wordLimit: 2000 },
        { id: uid('q'), title: '自由发挥', content: '题材不限，展现你的创意与文笔。', wordLimit: 2000 },
        { id: uid('q'), title: '我的社区故事', content: '写下你在社区里的经历或见闻。', wordLimit: 0 }
      ];
    }
  }
}
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDBNow, 80);
}
function saveDBNow() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const uid = (p) => p + '_' + crypto.randomBytes(9).toString('hex');

/* 类别白名单 */
const ART_CATS = ['散文', '小说', '科幻', '诗歌', '记叙文', '议论文', '随笔', '其他'];
const POST_CATS = ['题目讲解', '方法分享', '经验交流', '灌水闲聊', '其他'];

/* 题库种子题目 */
function seedProblems() {
  const mk = (type, title, content, difficulty, tags) => ({
    id: uid('q'), type, title, content, difficulty, tags, createdBy: 'u_admin', createdAt: Date.now() - 86400000, status: 'approved'
  });
  db.problems.push(
    // ---------- 主题写作 ----------
    mk('theme', '以「时光」为题，写一篇文章',
      '## 要求\n\n- 以「时光」为题，体裁不限（记叙文、散文、诗歌均可）\n- 围绕时光流逝中的人和事展开，要有真情实感\n- 建议字数 600-1500 字', 2, ['记叙', '抒情']),
    mk('theme', '以「窗外」为题，描写一个熟悉的场景',
      '## 要求\n\n- 以「窗外」为题\n- 选择一个你观察过的场景（街道、校园、老屋……）\n- 至少运用两种感官描写（视觉、听觉、嗅觉等）', 1, ['写景', '观察']),
    mk('theme', '以「选择」为题，写一次难忘的抉择',
      '## 要求\n\n- 以「选择」为题，写一次让你纠结、难忘的抉择\n- 写清楚：两难在哪里？你为什么这样选？事后怎么看？\n- 建议字数 800 字以上', 3, ['记叙', '成长']),
    mk('theme', '以「故乡」为题',
      '## 要求\n\n- 以「故乡」为题\n- 抓住故乡最有代表性的一两个意象（食物、方言、老街……）\n- 避免空泛抒情，用具体细节承载情感', 2, ['散文', '乡情']),
    mk('theme', '科幻微小说：一百年后的世界',
      '## 要求\n\n- 写一篇一百年后的世界为背景的微型小说\n- 必须有一个完整的小故事（起因-转折-结局）\n- 字数 1000 字以内，贵在立意和反转', 4, ['科幻', '小说']),
    mk('theme', '以「灯」为题',
      '## 要求\n\n- 以「灯」为题，可以写实（路灯、台灯）也可以写虚（心中的灯）\n- 让「灯」在文中承担象征意义', 3, ['象征', '散文']),
    // ---------- 专项训练 ----------
    mk('skill', '用排比写一段风景',
      '## 要求\n\n- 写一段 150-300 字的风景描写\n- 至少包含一组三句以上的排比句\n- 排比要有层次感，不要凑字数', 2, ['排比', '写景']),
    mk('skill', '用比喻描写「时间」',
      '## 要求\n\n- 写 3 个以上形容时间的比喻句\n- 不许用「时间像流水」这类常见比喻，追求新颖\n- 每个比喻配一句话展开', 1, ['比喻', '修辞']),
    mk('skill', '不用「哭」字，写一个人悲伤的样子',
      '## 要求\n\n- 写 100-200 字的片段\n- 全文禁止出现「哭」「泪」「难过」「伤心」\n- 只靠动作、神态、环境来传递悲伤', 3, ['细节描写', '侧面烘托']),
    mk('skill', '用「欲扬先抑」写一个人物',
      '## 要求\n\n- 写 300-500 字的人物片段\n- 先写缺点/不好的第一印象，再通过一件事反转\n- 反转要自然，不能突兀', 4, ['欲扬先抑', '人物']),
    mk('skill', '用对话推动一个故事',
      '## 要求\n\n- 写 300 字左右的片段\n- 情节推进必须全部靠对话完成，不许使用叙述交代\n- 对话要有「潜台词」，话里有话', 3, ['对话', '小说']),
    mk('skill', '用环境描写烘托紧张气氛',
      '## 要求\n\n- 写 150 字左右\n- 人物正在等待一个重要结果\n- 只写环境（光影、声音、物件），让读者自己紧张起来', 3, ['环境烘托', '气氛']),
    mk('skill', '用倒叙写一件小事',
      '## 要求\n\n- 写 400 字左右\n- 必须从事件的结尾或高潮写起，再回溯\n- 倒叙切入要自然，回到顺叙时交代清楚', 4, ['倒叙', '结构']),
    mk('skill', '把「他跑得很快」扩写成 150 字',
      '## 要求\n\n- 把这句话扩写成 150 字左右的片段\n- 至少从三个角度展开（动作、旁观者反应、环境变化）\n- 不许出现「很快」「飞快」这两个词', 1, ['扩写', '描写'])
  );
}

/* ---------------- 工具 ---------------- */
const pub = (u) => u && ({ id: u.id, username: u.username, nickname: u.nickname, role: u.role, bio: u.bio, createdAt: u.createdAt });
const userById = (id) => db.users.find(u => u.id === id);
const withAuthor = (item) => Object.assign({}, item, { author: pub(userById(item.authorId)) || { nickname: '已注销用户' } });

function articleOut(a) {
  const o = withAuthor(a);
  o.likeCount = (a.likes || []).length;
  delete o.likes;
  return o;
}
function postOut(p) {
  const o = withAuthor(p);
  o.commentCount = (p.comments || []).length;
  return o;
}

/* ---------------- 应用 ---------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* 安全响应头 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'");
  next();
});

/* 接口限速（按 IP） */
function rateLimit({ windowMs = 60000, max = 100 } = {}) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(k);
    if (!h || now > h.reset) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    h.count++;
    if (h.count > max) return res.status(429).json({ error: '操作太频繁了，请稍后再试' });
    next();
  };
}
app.use('/api', rateLimit({ max: 300 }));          // 全局：300 次/分钟
app.use('/api/login', rateLimit({ max: 10 }));     // 登录：10 次/分钟
app.use('/api/register', rateLimit({ max: 5 }));   // 注册：5 次/分钟

/* 密码策略：≥8 位且同时包含字母和数字 */
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

/* 会话持久化存储（重启不掉线） */
class FileStore extends session.Store {
  constructor(dir) {
    super();
    this.dir = dir;
    this.map = new Map();
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) {
          try { this.map.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) {}
        }
      }
    } catch (e) {}
    setInterval(() => {
      const now = Date.now();
      for (const [sid, s] of this.map) {
        if (s.cookie && s.cookie.expires && new Date(s.cookie.expires).getTime() < now) {
          this.map.delete(sid);
          try { fs.unlinkSync(path.join(dir, sid + '.json')); } catch (e) {}
        }
      }
    }, 3600000).unref();
  }
  get(sid, cb) { cb(null, this.map.get(sid) || null); }
  set(sid, sess, cb) {
    this.map.set(sid, sess);
    try { fs.writeFileSync(path.join(this.dir, sid + '.json'), JSON.stringify(sess)); } catch (e) {}
    cb && cb();
  }
  destroy(sid, cb) {
    this.map.delete(sid);
    try { fs.unlinkSync(path.join(this.dir, sid + '.json')); } catch (e) {}
    cb && cb();
  }
}
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
/* 会话密钥持久化，重启后会话仍有效 */
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const SESSION_SECRET = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8') : (fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex')), fs.readFileSync(SECRET_FILE, 'utf8'));

app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new FileStore(SESSION_DIR),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 }
}));
app.use(express.static(path.join(ROOT, 'public')));

function requireAuth(req, res, next) {
  const u = userById(req.session.userId);
  if (!u) return res.status(401).json({ error: '请先登录' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
const bad = (res, msg) => res.status(400).json({ error: msg });
const clean = (s, max) => String(s || '').trim().slice(0, max || 20000);

/* ---------------- 账号 ---------------- */
app.post('/api/register', (req, res) => {
  const username = clean(req.body.username, 24);
  const nickname = clean(req.body.nickname, 24) || username;
  const password = req.body.password;
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return bad(res, '用户名需为 3-24 位字母、数字或下划线');
  if (!validPassword(password)) return bad(res, '密码至少 8 位，且需同时包含字母和数字');
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return bad(res, '用户名已被占用');
  const user = Object.assign({ id: uid('u'), username, nickname, role: 'user', bio: '', createdAt: Date.now() }, hashPassword(password));
  db.users.push(user);
  saveDB();
  req.session.userId = user.id;
  res.json({ user: pub(user) });
});

app.post('/api/login', (req, res) => {
  const username = clean(req.body.username, 24);
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return bad(res, '用户名或密码错误');
  if (user.lockedUntil && Date.now() < user.lockedUntil) {
    const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `该账号已因多次登录失败被锁定，请 ${mins} 分钟后再试` });
  }
  if (!verifyPassword(req.body.password || '', user)) {
    user.loginFails = (user.loginFails || 0) + 1;
    if (user.loginFails >= 5) {
      user.lockedUntil = Date.now() + 10 * 60000;
      user.loginFails = 0;
      saveDB();
      return bad(res, '登录失败次数过多，账号已锁定 10 分钟');
    }
    saveDB();
    return bad(res, '用户名或密码错误');
  }
  user.loginFails = 0;
  user.lockedUntil = 0;
  req.session.userId = user.id;
  res.json({ user: pub(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: pub(userById(req.session.userId)) || null });
});

app.put('/api/me/profile', requireAuth, (req, res) => {
  const nickname = clean(req.body.nickname, 24);
  if (nickname) req.user.nickname = nickname;
  req.user.bio = clean(req.body.bio, 200);
  saveDB();
  res.json({ user: pub(req.user) });
});

app.put('/api/me/password', requireAuth, (req, res) => {
  if (!verifyPassword(req.body.oldPassword || '', req.user)) return bad(res, '原密码错误');
  if (!validPassword(req.body.newPassword)) return bad(res, '新密码至少 8 位，且需同时包含字母和数字');
  Object.assign(req.user, hashPassword(req.body.newPassword));
  saveDB();
  res.json({ ok: true });
});

app.get('/api/users/:id', (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const me = userById(req.session.userId);
  const articles = db.articles.filter(a => a.authorId === u.id && a.status === 'approved');
  const posts = db.posts.filter(p => p.authorId === u.id && p.status === 'approved');
  const likes = articles.reduce((s, a) => s + (a.likes || []).length, 0);
  const followerCount = db.users.filter(x => (x.following || []).includes(u.id)).length;
  const followingCount = (u.following || []).length;
  const isFollowing = !!(me && (me.following || []).includes(u.id));
  res.json({
    user: pub(u),
    stats: { articles: articles.length, posts: posts.length, likes, followerCount, followingCount },
    isFollowing,
    articles: articles.sort((a, b) => b.createdAt - a.createdAt).map(articleOut)
  });
});

/* ---------------- 关注 ---------------- */
app.post('/api/users/:id/follow', requireAuth, (req, res) => {
  const t = userById(req.params.id);
  if (!t) return res.status(404).json({ error: '用户不存在' });
  if (t.id === req.user.id) return bad(res, '不能关注自己');
  req.user.following = req.user.following || [];
  const i = req.user.following.indexOf(t.id);
  if (i >= 0) req.user.following.splice(i, 1); else req.user.following.push(t.id);
  saveDB();
  const followerCount = db.users.filter(x => (x.following || []).includes(t.id)).length;
  res.json({ followed: i < 0, followerCount });
});

app.get('/api/users/:id/following', (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ users: (u.following || []).map(id => pub(userById(id))).filter(Boolean) });
});

/* ---------------- 私信 ---------------- */
app.post('/api/messages', requireAuth, (req, res) => {
  const to = userById(req.body.toId);
  if (!to) return res.status(404).json({ error: '用户不存在' });
  if (to.id === req.user.id) return bad(res, '不能给自己发私信');
  const content = clean(req.body.content, 2000);
  if (!content) return bad(res, '内容不能为空');
  const m = { id: uid('m'), fromId: req.user.id, toId: to.id, content, createdAt: Date.now(), read: false };
  db.messages.push(m);
  saveDB();
  res.json({ message: m });
});

app.get('/api/messages/unread', requireAuth, (req, res) => {
  res.json({ count: db.messages.filter(m => m.toId === req.user.id && !m.read).length });
});

app.get('/api/messages/conversations', requireAuth, (req, res) => {
  const map = new Map();
  for (const m of db.messages) {
    const partnerId = m.fromId === req.user.id ? m.toId : (m.toId === req.user.id ? m.fromId : null);
    if (!partnerId) continue;
    let c = map.get(partnerId);
    if (!c) { c = { partnerId, last: m, unread: 0 }; map.set(partnerId, c); }
    if (m.createdAt > c.last.createdAt) c.last = m;
    if (m.toId === req.user.id && !m.read) c.unread++;
  }
  const conversations = [...map.values()]
    .sort((a, b) => b.last.createdAt - a.last.createdAt)
    .map(c => ({
      partner: pub(userById(c.partnerId)),
      lastContent: c.last.content, lastTime: c.last.createdAt,
      lastFromMe: c.last.fromId === req.user.id, unread: c.unread
    }))
    .filter(c => c.partner);
  res.json({ conversations });
});

app.get('/api/messages/with/:userId', requireAuth, (req, res) => {
  const other = userById(req.params.userId);
  if (!other) return res.status(404).json({ error: '用户不存在' });
  const list = db.messages
    .filter(m => (m.fromId === req.user.id && m.toId === other.id) || (m.fromId === other.id && m.toId === req.user.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  let changed = false;
  for (const m of list) if (m.toId === req.user.id && !m.read) { m.read = true; changed = true; }
  if (changed) saveDB();
  res.json({ partner: pub(other), messages: list });
});

/* ---------------- 首页 ---------------- */
app.get('/api/home', (req, res) => {
  const now = Date.now();
  res.json({
    stats: {
      users: db.users.length,
      articles: db.articles.filter(a => a.status === 'approved').length,
      posts: db.posts.filter(p => p.status === 'approved').length,
      contests: db.contests.length
    },
    latestArticles: db.articles.filter(a => a.status === 'approved').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(articleOut),
    latestPosts: db.posts.filter(p => p.status === 'approved').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(postOut),
    activeContests: db.contests.filter(c => c.startTime <= now && now <= c.endTime).slice(0, 3)
  });
});

/* ---------------- 文章 ---------------- */
const matches = (text, q) => String(text || '').toLowerCase().includes(q);
function searchFilter(list, q) {
  if (!q) return list;
  const lq = String(q).toLowerCase();
  return list.filter(x => matches(x.title, lq) || matches(x.content, lq) || matches((userById(x.authorId) || {}).nickname, lq));
}

app.get('/api/articles', (req, res) => {
  let list = db.articles.filter(a => a.status === 'approved');
  if (req.query.category) list = list.filter(a => (a.category || '其他') === req.query.category);
  list = searchFilter(list, req.query.q);
  if (req.query.sort === 'hot') list.sort((a, b) => ((b.likes || []).length * 5 + b.views) - ((a.likes || []).length * 5 + a.views));
  else list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ articles: list.map(articleOut) });
});

app.get('/api/articles/mine', requireAuth, (req, res) => {
  res.json({ articles: db.articles.filter(a => a.authorId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(articleOut) });
});

app.get('/api/articles/:id', (req, res) => {
  const a = db.articles.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '文章不存在' });
  const me = userById(req.session.userId);
  const canView = a.status === 'approved' || (me && (me.id === a.authorId || me.role === 'admin'));
  if (!canView) return res.status(403).json({ error: '文章正在审核中' });
  if (!me || me.id !== a.authorId) { a.views = (a.views || 0) + 1; saveDB(); }
  const o = articleOut(a);
  o.liked = !!(me && (a.likes || []).includes(me.id));
  res.json({ article: o });
});

app.post('/api/articles', requireAuth, (req, res) => {
  const title = clean(req.body.title, 80);
  const content = clean(req.body.content, 50000);
  if (!title || !content) return bad(res, '标题和内容不能为空');
  const category = ART_CATS.includes(req.body.category) ? req.body.category : '其他';
  const a = { id: uid('a'), authorId: req.user.id, title, content, category, status: 'pending', views: 0, likes: [], createdAt: Date.now() };
  db.articles.push(a);
  saveDB();
  res.json({ article: articleOut(a) });
});

app.put('/api/articles/:id', requireAuth, (req, res) => {
  const a = db.articles.find(x => x.id === req.params.id);
  if (!a || a.authorId !== req.user.id) return res.status(404).json({ error: '文章不存在或无权限' });
  a.title = clean(req.body.title, 80) || a.title;
  a.content = clean(req.body.content, 50000) || a.content;
  if (ART_CATS.includes(req.body.category)) a.category = req.body.category;
  if (a.status !== 'approved') a.status = 'pending';
  saveDB();
  res.json({ article: articleOut(a) });
});

app.delete('/api/articles/:id', requireAuth, (req, res) => {
  const i = db.articles.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '文章不存在' });
  if (db.articles[i].authorId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  db.articles.splice(i, 1);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/articles/:id/like', requireAuth, (req, res) => {
  const a = db.articles.find(x => x.id === req.params.id && x.status === 'approved');
  if (!a) return res.status(404).json({ error: '文章不存在' });
  a.likes = a.likes || [];
  const i = a.likes.indexOf(req.user.id);
  if (i >= 0) a.likes.splice(i, 1); else a.likes.push(req.user.id);
  saveDB();
  res.json({ liked: i < 0, likeCount: a.likes.length });
});

/* ---------------- 论坛帖子 ---------------- */
app.get('/api/posts', (req, res) => {
  let list = db.posts.filter(p => p.status === 'approved');
  if (req.query.category) list = list.filter(p => (p.category || '其他') === req.query.category);
  list = searchFilter(list, req.query.q);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ posts: list.map(postOut) });
});

app.get('/api/posts/mine', requireAuth, (req, res) => {
  res.json({ posts: db.posts.filter(p => p.authorId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(postOut) });
});

app.get('/api/posts/:id', (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  const me = userById(req.session.userId);
  if (p.status !== 'approved' && !(me && (me.id === p.authorId || me.role === 'admin'))) {
    return res.status(403).json({ error: '帖子正在审核中' });
  }
  const o = postOut(p);
  o.comments = (p.comments || []).map(c => withAuthor(c));
  res.json({ post: o });
});

app.post('/api/posts', requireAuth, (req, res) => {
  const title = clean(req.body.title, 80);
  const content = clean(req.body.content, 20000);
  if (!title || !content) return bad(res, '标题和内容不能为空');
  const category = POST_CATS.includes(req.body.category) ? req.body.category : '其他';
  const p = { id: uid('p'), authorId: req.user.id, title, content, category, status: 'pending', createdAt: Date.now(), comments: [] };
  db.posts.push(p);
  saveDB();
  res.json({ post: postOut(p) });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id && x.status === 'approved');
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  const content = clean(req.body.content, 2000);
  if (!content) return bad(res, '评论不能为空');
  const c = { id: uid('c'), authorId: req.user.id, content, createdAt: Date.now() };
  p.comments.push(c);
  saveDB();
  res.json({ comment: withAuthor(c) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const i = db.posts.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '帖子不存在' });
  if (db.posts[i].authorId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  db.posts.splice(i, 1);
  saveDB();
  res.json({ ok: true });
});

/* ---------------- 比赛 ---------------- */
function contestOut(c) {
  const now = Date.now();
  const status = now < c.startTime ? 'upcoming' : now > c.endTime ? 'ended' : 'ongoing';
  return Object.assign({}, c, {
    status,
    problemCount: (c.problems || []).length,
    submissionCount: (c.submissions || []).length,
    participantCount: (c.participants || []).length,
    creator: pub(userById(c.createdBy))
  });
}

app.get('/api/contests', (req, res) => {
  res.json({ contests: db.contests.slice().sort((a, b) => b.createdAt - a.createdAt).map(contestOut) });
});

app.get('/api/contests/:id', (req, res) => {
  const c = db.contests.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  const o = contestOut(c);
  const me = userById(req.session.userId);
  o.joined = !!(me && (c.participants || []).includes(me.id));
  o.participantList = (c.participants || []).map(id => pub(userById(id))).filter(Boolean);
  delete o.participants;
  delete o.submissions; // 不公开他人作品
  res.json({ contest: o });
});

app.post('/api/contests', requireAuth, requireAdmin, (req, res) => {
  const title = clean(req.body.title, 80);
  const description = clean(req.body.description, 20000);
  const startTime = Number(req.body.startTime);
  const endTime = Number(req.body.endTime);
  if (!title || !description) return bad(res, '标题和说明不能为空');
  if (!startTime || !endTime || endTime <= startTime) return bad(res, '结束时间必须晚于开始时间');
  const rawProblems = Array.isArray(req.body.problems) ? req.body.problems : [];
  if (!rawProblems.length) return bad(res, '至少需要布置一道题目');
  const problems = rawProblems.slice(0, 10).map(p => ({
    id: uid('q'),
    title: clean(p.title, 60),
    content: clean(p.content, 10000),
    wordLimit: Math.max(0, parseInt(p.wordLimit, 10) || 0)
  })).filter(p => p.title && p.content);
  if (!problems.length) return bad(res, '每道题目的标题和内容不能为空');
  const c = { id: uid('c'), title, description, problems, startTime, endTime, createdBy: req.user.id, createdAt: Date.now(), participants: [], submissions: [] };
  db.contests.push(c);
  saveDB();
  res.json({ contest: contestOut(c) });
});

/* 参赛者按题目提交作品（每题一篇，可反复修改覆盖） */
app.post('/api/contests/:id/submit', requireAuth, (req, res) => {
  const c = db.contests.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  if (Date.now() < c.startTime) return bad(res, '比赛尚未开始');
  if (Date.now() > c.endTime) return bad(res, '比赛已结束，无法提交');
  if (!(c.participants || []).includes(req.user.id)) return bad(res, '请先报名比赛');
  const p = (c.problems || []).find(q => q.id === req.body.problemId);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  const title = clean(req.body.title, 80);
  const content = clean(req.body.content, 50000);
  if (!title || !content) return bad(res, '标题和内容不能为空');
  const wordCount = content.replace(/\s/g, '').length;
  if (p.wordLimit > 0 && wordCount > p.wordLimit) return bad(res, `超出字数限制：当前 ${wordCount} 字 / 上限 ${p.wordLimit} 字`);
  c.submissions = c.submissions || [];
  let s = c.submissions.find(x => x.problemId === p.id && x.authorId === req.user.id);
  if (s) {
    s.title = title; s.content = content; s.wordCount = wordCount; s.updatedAt = Date.now();
  } else {
    s = { id: uid('s'), problemId: p.id, authorId: req.user.id, title, content, wordCount, createdAt: Date.now() };
    c.submissions.push(s);
  }
  saveDB();
  res.json({ submission: s });
});

app.get('/api/contests/:id/my-submissions', requireAuth, (req, res) => {
  const c = db.contests.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  res.json({ submissions: (c.submissions || []).filter(s => s.authorId === req.user.id) });
});

app.get('/api/contests/:id/submissions', requireAuth, requireAdmin, (req, res) => {
  const c = db.contests.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  res.json({
    problems: c.problems || [],
    submissions: (c.submissions || []).map(s => { const o = withAuthor(s); delete o.content; return o; })
  });
});

app.post('/api/contests/:id/join', requireAuth, (req, res) => {
  const c = db.contests.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  if (Date.now() > c.endTime) return bad(res, '比赛已结束');
  c.participants = c.participants || [];
  const i = c.participants.indexOf(req.user.id);
  if (i >= 0) c.participants.splice(i, 1); else c.participants.push(req.user.id);
  saveDB();
  res.json({ joined: i < 0, participantCount: c.participants.length });
});

app.delete('/api/contests/:id', requireAuth, requireAdmin, (req, res) => {
  const i = db.contests.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '比赛不存在' });
  db.contests.splice(i, 1);
  saveDB();
  res.json({ ok: true });
});

/* ---------------- 文件投稿 ---------------- */
/* 允许上传的文件类型白名单（拦截可执行文件、脚本、网页等危险类型） */
const ALLOW_EXT = ['.txt', '.md', '.doc', '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.zip', '.rar', '.7z', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.mp3', '.mp4'];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, uid('f') + path.extname(file.originalname).slice(0, 10))
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOW_EXT.includes(ext)) return cb(new Error('不允许上传该类型的文件'));
    cb(null, true);
  }
});

app.post('/api/files', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 20MB' : (err.message || '上传失败'));
    if (!req.file) return bad(res, '请选择文件');
    const f = {
      id: uid('f'), authorId: req.user.id,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      storedName: req.file.filename, size: req.file.size,
      note: clean(req.body.note, 200), status: 'pending', createdAt: Date.now()
    };
    db.files.push(f);
    saveDB();
    res.json({ file: withAuthor(f) });
  });
});

app.get('/api/files/mine', requireAuth, (req, res) => {
  res.json({ files: db.files.filter(f => f.authorId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(withAuthor) });
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  if (f.authorId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '无权限下载' });
  res.download(path.join(UPLOAD_DIR, f.storedName), f.originalName);
});

/* ---------------- 题库 ---------------- */
function problemOut(p) {
  const ps = db.practices.filter(x => x.problemId === p.id);
  return Object.assign({}, p, {
    status: p.status || 'approved',
    proposer: pub(userById(p.createdBy)) || { nickname: '已注销用户' },
    practiceCount: ps.length,
    doerCount: new Set(ps.map(x => x.authorId)).size
  });
}

app.get('/api/problems', (req, res) => {
  let list = db.problems.filter(p => (p.status || 'approved') === 'approved');
  if (['theme', 'skill'].includes(req.query.type)) list = list.filter(p => p.type === req.query.type);
  if (req.query.difficulty) list = list.filter(p => p.difficulty === Number(req.query.difficulty));
  if (req.query.tag) list = list.filter(p => (p.tags || []).includes(req.query.tag));
  list = searchFilter(list, req.query.q);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ problems: list.map(problemOut) });
});

app.get('/api/problems/:id', (req, res) => {
  const p = db.problems.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  const me = userById(req.session.userId);
  if ((p.status || 'approved') !== 'approved' && !(me && (me.id === p.createdBy || me.role === 'admin'))) {
    return res.status(403).json({ error: '题目正在审核中' });
  }
  const practices = db.practices.filter(x => x.problemId === p.id).sort((a, b) => b.createdAt - a.createdAt);
  const mine = me ? practices.find(x => x.authorId === me.id) || null : null;
  res.json({
    problem: problemOut(p),
    myPractice: mine,
    practices: practices.slice(0, 50).map(x => { const o = withAuthor(x); delete o.content; return o; })
  });
});

/* 收录题目：管理员直接生效，普通用户投稿需审核 */
app.post('/api/problems', requireAuth, (req, res) => {
  const title = clean(req.body.title, 80);
  const content = clean(req.body.content, 10000);
  const type = req.body.type === 'skill' ? 'skill' : 'theme';
  const difficulty = Math.min(6, Math.max(1, parseInt(req.body.difficulty, 10) || 1));
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map(t => clean(t, 12)).filter(Boolean).slice(0, 5) : [];
  if (!title || !content) return bad(res, '题目标题和内容不能为空');
  const isAdmin = req.user.role === 'admin';
  const p = { id: uid('q'), type, title, content, difficulty, tags, createdBy: req.user.id, createdAt: Date.now(), status: isAdmin ? 'approved' : 'pending' };
  db.problems.push(p);
  saveDB();
  res.json({ problem: problemOut(p) });
});

app.delete('/api/problems/:id', requireAuth, requireAdmin, (req, res) => {
  const i = db.problems.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '题目不存在' });
  db.practices = db.practices.filter(x => x.problemId !== req.params.id);
  db.problems.splice(i, 1);
  saveDB();
  res.json({ ok: true });
});

/* 提交练习（每人每题一篇，可覆盖修改） */
app.post('/api/problems/:id/practice', requireAuth, (req, res) => {
  const p = db.problems.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  if ((p.status || 'approved') !== 'approved') return bad(res, '题目尚未通过审核');
  const title = clean(req.body.title, 80);
  const content = clean(req.body.content, 50000);
  if (!title || !content) return bad(res, '标题和内容不能为空');
  const wordCount = content.replace(/\s/g, '').length;
  let s = db.practices.find(x => x.problemId === p.id && x.authorId === req.user.id);
  if (s) {
    s.title = title; s.content = content; s.wordCount = wordCount; s.updatedAt = Date.now();
  } else {
    s = { id: uid('r'), problemId: p.id, authorId: req.user.id, title, content, wordCount, createdAt: Date.now() };
    db.practices.push(s);
  }
  saveDB();
  res.json({ practice: s });
});

app.get('/api/problems/:id/practice/:prId', (req, res) => {
  const s = db.practices.find(x => x.id === req.params.prId && x.problemId === req.params.id);
  if (!s) return res.status(404).json({ error: '练习不存在' });
  res.json({ practice: withAuthor(s) });
});

app.get('/api/problems/:id/my-practice', requireAuth, (req, res) => {
  const s = db.practices.find(x => x.problemId === req.params.id && x.authorId === req.user.id);
  res.json({ practice: s || null });
});

/* ---------------- 排行榜 ---------------- */
app.get('/api/rank', (req, res) => {
  const rows = db.users.map(u => {
    const arts = db.articles.filter(a => a.authorId === u.id && a.status === 'approved');
    const posts = db.posts.filter(p => p.authorId === u.id && p.status === 'approved');
    const likes = arts.reduce((s, a) => s + (a.likes || []).length, 0);
    const comments = posts.reduce((s, p) => s + (p.comments || []).length, 0);
    const practices = db.practices.filter(x => x.authorId === u.id).length;
    const score = arts.length * 10 + posts.length * 5 + likes * 3 + comments * 2 + practices * 2;
    return { user: pub(u), score, articles: arts.length, posts: posts.length, likes, practices };
  }).filter(r => r.score > 0 || r.user.role === 'admin');
  rows.sort((a, b) => b.score - a.score);
  res.json({ rank: rows.slice(0, 50) });
});

/* ---------------- 后台管理 ---------------- */
app.get('/api/admin/articles', requireAuth, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ articles: db.articles.filter(a => a.status === status).sort((a, b) => b.createdAt - a.createdAt).map(articleOut) });
});

app.post('/api/admin/articles/:id/review', requireAuth, requireAdmin, (req, res) => {
  const a = db.articles.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '文章不存在' });
  a.status = req.body.action === 'approve' ? 'approved' : 'rejected';
  a.reviewedAt = Date.now();
  saveDB();
  res.json({ ok: true, status: a.status });
});

app.get('/api/admin/posts', requireAuth, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ posts: db.posts.filter(p => p.status === status).sort((a, b) => b.createdAt - a.createdAt).map(postOut) });
});

app.post('/api/admin/posts/:id/review', requireAuth, requireAdmin, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  p.status = req.body.action === 'approve' ? 'approved' : 'rejected';
  p.reviewedAt = Date.now();
  saveDB();
  res.json({ ok: true, status: p.status });
});

app.get('/api/admin/files', requireAuth, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ files: db.files.filter(f => f.status === status).sort((a, b) => b.createdAt - a.createdAt).map(withAuthor) });
});

app.get('/api/admin/problems', requireAuth, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ problems: db.problems.filter(p => (p.status || 'approved') === status).sort((a, b) => b.createdAt - a.createdAt).map(problemOut) });
});

app.post('/api/admin/problems/:id/review', requireAuth, requireAdmin, (req, res) => {
  const p = db.problems.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  p.status = req.body.action === 'approve' ? 'approved' : 'rejected';
  p.reviewedAt = Date.now();
  saveDB();
  res.json({ ok: true, status: p.status });
});

app.post('/api/admin/files/:id/review', requireAuth, requireAdmin, (req, res) => {
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  f.status = req.body.action === 'approve' ? 'approved' : 'rejected';
  f.reviewedAt = Date.now();
  saveDB();
  res.json({ ok: true, status: f.status });
});

/* ---------------- 全局错误处理 ---------------- */
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求数据格式无效' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '请求数据过大' });
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ---------------- 启动 ---------------- */
loadDB();
app.listen(PORT, HOST, () => {
  console.log(`文洛 · 文章竞赛社区 已启动: http://${HOST}:${PORT}`);
  console.log('管理员账号: admin / admin123');
});
