require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { BOT_TOKEN, SMM_API_URL, SMM_API_KEY, ADMIN_ID, PORT = 10000 } = process.env;
if (!BOT_TOKEN || !SMM_API_URL || !SMM_API_KEY || !ADMIN_ID) {
  console.error("Missing required environment variables. Check Render Environment settings.");
  process.exit(1);
}

const adminId = String(ADMIN_ID);
const bot = new Telegraf(BOT_TOKEN);
const DB_FILE = path.join(__dirname, "data.json");
let db = { users: {}, pending: {} };

try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch (e) {
  console.error("Could not read data.json; starting with an empty database.", e.message);
}
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function userFor(ctx) {
  const id = String(ctx.from.id);
  if (!db.users[id]) db.users[id] = { balance: 0, username: ctx.from.username || "" };
  db.users[id].username = ctx.from.username || db.users[id].username || "";
  save();
  return db.users[id];
}
function isAdmin(ctx) { return String(ctx.from.id) === adminId; }

async function panel(action, params = {}) {
  const body = new URLSearchParams({ key: SMM_API_KEY, action, ...params });
  const response = await axios.post(SMM_API_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000
  });
  if (response.data && response.data.error) throw new Error(response.data.error);
  return response.data;
}
function money(n) { return Number(n || 0).toFixed(2); }
function mainMenu() {
  return Markup.keyboard([
    ["📋 الخدمات", "💰 رصيدي"],
    ["🛒 طلب جديد", "🔎 حالة طلب"],
    ["ℹ️ المساعدة"]
  ]).resize();
}
function parseList(data) {
  if (!Array.isArray(data)) throw new Error("Unexpected services response from API");
  return data;
}
async function showServices(ctx) {
  const services = parseList(await panel("services"));
  const active = services.filter(s => s && s.service && s.name);
  if (!active.length) return ctx.reply("لم تصل خدمات من مزود API.");
  const lines = active.slice(0, 60).map(s =>
    `🆔 ${s.service} — ${String(s.name).slice(0, 75)}\n💵 السعر/1000: ${s.rate} | الحد: ${s.min}-${s.max}`
  );
  await ctx.reply("📋 الخدمات المتاحة (أول 60 خدمة):\n\n" + lines.join("\n\n") +
    "\n\nلطلب خدمة اضغط «طلب جديد» ثم أرسل رقم الخدمة.");
}

bot.start(async ctx => {
  userFor(ctx);
  await ctx.reply(
    "أهلاً بك في بوت الخدمات 🚀\nاختر من القائمة بالأسفل.",
    mainMenu()
  );
});
bot.hears("📋 الخدمات", showServices);
bot.hears("💰 رصيدي", async ctx => {
  const u = userFor(ctx);
  await ctx.reply(`💰 رصيدك: ${money(u.balance)}`);
});
bot.hears("ℹ️ المساعدة", ctx => ctx.reply(
  "طريقة الطلب:\n1) اضغط طلب جديد.\n2) أرسل رقم الخدمة.\n3) أرسل رابط المنشور/الحساب.\n4) أرسل الكمية.\n\nللاستفسار عن الشحن تواصل مع الإدارة."
));
bot.hears("🛒 طلب جديد", async ctx => {
  userFor(ctx);
  db.pending[String(ctx.from.id)] = { step: "service" };
  save();
  ctx.reply("أرسل رقم الخدمة (Service ID). أرسل /cancel للإلغاء.");
});
bot.hears("🔎 حالة طلب", ctx => {
  db.pending[String(ctx.from.id)] = { step: "status" };
  save();
  ctx.reply("أرسل رقم الطلب الذي تريد متابعة حالته.");
});
bot.command("cancel", ctx => {
  delete db.pending[String(ctx.from.id)];
  save();
  ctx.reply("تم إلغاء العملية.", mainMenu());
});
bot.command("id", ctx => ctx.reply(`Telegram ID: ${ctx.from.id}`));

bot.command("addbalance", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("غير مصرح.");
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || !Number.isFinite(Number(parts[2])) || Number(parts[2]) <= 0) {
    return ctx.reply("الصيغة:\n/addbalance USER_ID AMOUNT");
  }
  const target = parts[1], amount = Number(parts[2]);
  if (!db.users[target]) db.users[target] = { balance: 0, username: "" };
  db.users[target].balance += amount;
  save();
  ctx.reply(`تمت إضافة ${money(amount)} إلى المستخدم ${target}.`);
  try { await bot.telegram.sendMessage(target, `✅ تمت إضافة ${money(amount)} إلى رصيدك.`); } catch {}
});
bot.command("panelbalance", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("غير مصرح.");
  try {
    const b = await panel("balance");
    ctx.reply(`رصيد لوحة API:\n${JSON.stringify(b)}`);
  } catch (e) { ctx.reply(`خطأ API: ${e.message}`); }
});

bot.on("text", async ctx => {
  const id = String(ctx.from.id);
  const pending = db.pending[id];
  if (!pending) return;
  const value = ctx.message.text.trim();
  if (value.startsWith("/")) return;

  try {
    if (pending.step === "status") {
      if (!/^\d+$/.test(value)) return ctx.reply("أرسل رقم طلب صحيح أو /cancel.");
      const result = await panel("status", { order: value });
      delete db.pending[id]; save();
      return ctx.reply("📊 حالة الطلب:\n" + JSON.stringify(result, null, 2), mainMenu());
    }
    if (pending.step === "service") {
      if (!/^\d+$/.test(value)) return ctx.reply("أرسل رقم الخدمة فقط.");
      const services = parseList(await panel("services"));
      const service = services.find(s => String(s.service) === value);
      if (!service) return ctx.reply("لم أجد هذه الخدمة. أرسل رقماً صحيحاً أو /cancel.");
      db.pending[id] = { step: "link", service: value, rate: Number(service.rate), min: Number(service.min), max: Number(service.max), name: service.name };
      save();
      return ctx.reply(`الخدمة: ${service.name}\nالسعر لكل 1000: ${service.rate}\nأرسل الرابط الآن.`);
    }
    if (pending.step === "link") {
      if (!/^https?:\/\/\S+/i.test(value)) return ctx.reply("أرسل رابطاً يبدأ بـ http:// أو https://");
      pending.link = value; pending.step = "quantity"; save();
      return ctx.reply(`أرسل الكمية بين ${pending.min} و ${pending.max}.`);
    }
    if (pending.step === "quantity") {
      if (!/^\d+$/.test(value)) return ctx.reply("أرسل كمية صحيحة بالأرقام.");
      const quantity = Number(value);
      if (quantity < pending.min || quantity > pending.max) return ctx.reply(`الكمية يجب أن تكون بين ${pending.min} و ${pending.max}.`);
      const cost = pending.rate * quantity / 1000;
      const user = userFor(ctx);
      if (user.balance < cost) {
        delete db.pending[id]; save();
        return ctx.reply(`رصيدك غير كافٍ.\nالتكلفة: ${money(cost)}\nرصيدك: ${money(user.balance)}\nتواصل مع الإدارة للشحن.`, mainMenu());
      }
      const result = await panel("add", { service: pending.service, link: pending.link, quantity: String(quantity) });
      if (!result || !result.order) throw new Error("لم يرجع المزود رقم الطلب؛ لم يتم خصم الرصيد المحلي. تحقق من لوحة المزود.");
      user.balance -= cost;
      delete db.pending[id]; save();
      return ctx.reply(`✅ تم إرسال الطلب بنجاح!\n🆔 رقم الطلب: ${result.order}\n📦 الكمية: ${quantity}\n💵 التكلفة: ${money(cost)}\n💰 الرصيد المتبقي: ${money(user.balance)}`, mainMenu());
    }
  } catch (e) {
    console.error("Request error:", e.response?.data || e.message);
    return ctx.reply(`حدث خطأ أثناء الاتصال بمزود الخدمة:\n${e.response?.data?.error || e.message}\n\nلم يتم تأكيد تنفيذ الطلب. تواصل مع الإدارة إذا ظهر الطلب في لوحة المزود.`);
  }
});

bot.catch((err, ctx) => {
  console.error("Telegram bot error:", err);
  try { ctx.reply("حدث خطأ غير متوقع. حاول لاحقاً."); } catch {}
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Telegram SMM bot is running");
});
server.listen(Number(PORT), "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));
bot.launch().then(() => console.log("Telegram bot started with long polling."));

process.once("SIGINT", () => { bot.stop("SIGINT"); server.close(); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); server.close(); });
