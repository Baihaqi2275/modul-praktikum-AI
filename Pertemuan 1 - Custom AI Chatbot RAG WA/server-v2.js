require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const RAGEngine = require("./lib/rag");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Inisialisasi Groq SDK
let groq = null;
if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// Inisialisasi RAG Engine
const ragEngine = new RAGEngine(path.join(__dirname, "data/products.csv"));

// Load Knowledge Base
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");
let knowledge = { keywords: {}, responses: {} };
function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Gagal membaca knowledge.json:", err);
  }
}
loadKnowledge();

// State WhatsApp Bot
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;

// ================= KUOTA & RATE LIMIT GROQ AI =================
let groqQuota = {
  model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  remainingRequests: null,
  limitRequests: null,
  remainingTokens: null,
  limitTokens: null,
  resetRequests: null,
  lastChecked: null,
  configured: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq")
};

function updateGroqQuotaFromHeaders(headers, modelName) {
  if (!headers) return;
  groqQuota.model = modelName || process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  const remReq = headers.get ? headers.get("x-ratelimit-remaining-requests") : headers["x-ratelimit-remaining-requests"];
  const limReq = headers.get ? headers.get("x-ratelimit-limit-requests") : headers["x-ratelimit-limit-requests"];
  const remTok = headers.get ? headers.get("x-ratelimit-remaining-tokens") : headers["x-ratelimit-remaining-tokens"];
  const limTok = headers.get ? headers.get("x-ratelimit-limit-tokens") : headers["x-ratelimit-limit-tokens"];
  const rstReq = headers.get ? headers.get("x-ratelimit-reset-requests") : headers["x-ratelimit-reset-requests"];

  if (remReq) groqQuota.remainingRequests = Number(remReq);
  if (limReq) groqQuota.limitRequests = Number(limReq);
  if (remTok) groqQuota.remainingTokens = Number(remTok);
  if (limTok) groqQuota.limitTokens = Number(limTok);
  if (rstReq) groqQuota.resetRequests = rstReq;
  groqQuota.lastChecked = new Date().toLocaleTimeString("id-ID");
  groqQuota.configured = true;
}

async function fetchGroqQuotaFresh() {
  if (!groq) {
    if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
      groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      return groqQuota;
    }
  }

  const modelToUse = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  try {
    const { response } = await groq.chat.completions.create({
      model: modelToUse,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1
    }).withResponse();

    updateGroqQuotaFromHeaders(response.headers, modelToUse);
  } catch (err) {
    console.warn("Gagal mengecek kuota Groq:", err.message);
  }
  return groqQuota;
}

// ================= CONVERSATION HISTORY (MULTI-TURN MEMORY) =================
// Menyimpan riwayat percakapan per nomor pengirim (msg.from)
// Menggunakan sliding window (maks 6 pesan: 3 pertanyaan user & 3 respon bot)
// dan auto-expire setelah 20 menit tidak aktif.
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 menit

function getUserHistory(senderId) {
  if (!senderId) return [];
  const session = conversationHistory.get(senderId);
  const now = Date.now();

  if (!session) return [];

  // Jika sesi sudah tidak aktif lebih dari 20 menit, reset
  if (now - session.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }

  return session.messages || [];
}

function appendUserHistory(senderId, userMsg, botReply) {
  if (!senderId) return;
  const now = Date.now();
  let session = conversationHistory.get(senderId);

  if (!session || (now - session.lastActive > SESSION_TTL_MS)) {
    session = { messages: [], lastActive: now };
  }

  session.messages.push({ role: "user", content: userMsg });
  session.messages.push({ role: "assistant", content: botReply });

  // Batasi hanya menyimpan pesan terakhir
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  }

  session.lastActive = now;
  conversationHistory.set(senderId, session);
}

// Helper deteksi path Chrome / Edge di sistem operasi (mencegah error 'Could not find Chrome')
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function initializeClient() {
  if (client) return client;

  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  };

  const detectedChrome = getChromeExecutablePath();
  if (detectedChrome) {
    puppeteerOptions.executablePath = detectedChrome;
    console.log(`[Puppeteer] Menggunakan browser sistem: ${detectedChrome}`);
  }

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "chatbot-rag"
    }),
    puppeteer: puppeteerOptions
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("Pindai QR code di atas atau melalui web dashboard.");
    console.log("==================================================\n");
  });

  client.on("authenticated", () => {
    console.log("Autentikasi WhatsApp berhasil.");
  });

  client.on("auth_failure", msg => {
    console.error("Autentikasi WhatsApp gagal:", msg);
    isInitializing = false;
  });

  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp siap digunakan");
  });

  client.on("disconnected", reason => {
    console.log("WhatsApp terputus:", reason);
    isReady = false;
    qrCodeData = null;
    client = null;
  });

  // Handler Pesan Pribadi
  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;

      const isPersonalChat =
        msg.from.endsWith("@c.us") ||
        msg.from.endsWith("@lid");
      const isNotStatus = !msg.from.endsWith("@status");

      if (!isPersonalChat || !isNotStatus) {
        console.log("Pesan grup/status diabaikan:", msg.from);
        return;
      }

      const message = msg.body.trim();
      console.log(`[Pesan Masuk dari ${msg.from}]: ${message}`);

      const reply = await getAIResponse(msg.from, message);
      await msg.reply(reply);
      console.log(`[Balasan Terkirim]: ${reply}`);
    } catch (err) {
      console.error("Error memproses pesan:", err);
      try {
        await msg.reply("Mohon maaf, saat ini sistem asisten sedang mengalami gangguan teknis. Silakan coba kembali sesaat lagi.");
      } catch (replyErr) {
        console.error("Gagal mengirim pesan error fallback:", replyErr);
      }
    }
  });

  return client;
}

// Helper Format Teks untuk WhatsApp (Bold *teks*, normalisasi spasi)
function formatWhatsAppMessage(text) {
  if (!text) return "";
  // 1. Ubah markdown bold double asterisks **teks** menjadi single asterisk *teks* untuk WhatsApp
  let formatted = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  // 2. Pastikan tidak ada lebih dari 2 baris kosong berturut-turut
  formatted = formatted.replace(/\n{3,}/g, "\n\n").trim();
  return formatted;
}

// Helper deteksi sapaan/salam murni
function isGreetingMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const greetings = [
    "halo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test",
    "pagi", "selamat pagi", "siang", "selamat siang", "sore", "selamat sore",
    "malam", "selamat malam", "assalamualaikum", "assalamu'alaikum",
    "assalamu alaikum", "permisi", "sampurasun"
  ];
  if (greetings.includes(q)) return true;

  if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum|permisi)\b/i.test(q)) {
    const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "gelang", "cincin", "kalung", "anting", "emas", "berlian"];
    return !productKeywords.some(pk => q.includes(pk));
  }
  return false;
}

// Helper deteksi ucapan terima kasih
function isGratitudeMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const gratitudeList = [
    "terima kasih", "terimakasih", "makasih", "makasi", "thx", "thanks", "thank you",
    "matur nuwun", "nuhun", "syukron", "terima kasih banyak", "terimakasih banyak", "makasih banyak"
  ];
  if (gratitudeList.includes(q)) return true;

  return /^(terima\s*kasih|makasih|makasi|thanks|thank\s*you|thx|matur\s*nuwun|nuhun|syukron)\b/i.test(q);
}

// Logika Respons AI & Basis Pengetahuan dengan Conversation History
async function getAIResponse(senderId, message) {
  const normalized = message.toLowerCase().trim();

  // 1. Template Sistem Cepat: Sapaan Awal (Langsung dijawab tanpa memanggil Groq AI)
  if (isGreetingMessage(normalized)) {
    console.log("[Template Sapaan]: Menggunakan template sistem cepat (tanpa panggil AI)");
    const greetingReply = "Halo! Selamat datang di *Aura Jewelry & Gold Atelier*. ✨\n\nAda yang bisa kami bantu seputar koleksi perhiasan kami hari ini? 😊";
    if (senderId) appendUserHistory(senderId, message, greetingReply);
    return greetingReply;
  }

  // 2. Template Sistem Cepat: Ucapan Terima Kasih (Langsung dijawab tanpa memanggil Groq AI)
  if (isGratitudeMessage(normalized)) {
    console.log("[Template Terima Kasih]: Menggunakan template sistem cepat (tanpa panggil AI)");
    const gratitudeReply = "Sama-sama! Senang bisa membantu Anda di *Aura Jewelry & Gold Atelier*. ✨\n\nJika ada pertanyaan lain atau ingin melakukan pemesanan, silakan hubungi kami kembali ya! 😊";
    if (senderId) appendUserHistory(senderId, message, gratitudeReply);
    return gratitudeReply;
  }

  // 3. Cek respons manual langsung dari knowledge.json
  if (knowledge.responses && knowledge.responses[normalized]) {
    console.log("[Knowledge Match]: Menggunakan jawaban manual keyword");
    const manualReply = formatWhatsAppMessage(knowledge.responses[normalized]);
    if (senderId) appendUserHistory(senderId, message, manualReply);
    return manualReply;
  }

  // 4. Cek apakah ada keyword alias di knowledge.keywords
  if (knowledge.keywords) {
    for (const [kw, targetKey] of Object.entries(knowledge.keywords)) {
      if (normalized.includes(kw.toLowerCase())) {
        if (knowledge.responses && knowledge.responses[targetKey]) {
          console.log(`[Knowledge Keyword Match]: Cocok dengan keyword '${kw}'`);
          const manualReply = formatWhatsAppMessage(knowledge.responses[targetKey]);
          if (senderId) appendUserHistory(senderId, message, manualReply);
          return manualReply;
        }
      }
    }
  }

  // 5. Ambil riwayat percakapan sebelumnya untuk nomor pengguna ini
  const history = senderId ? getUserHistory(senderId) : [];

  // 6. RAG Context dari CSV produk
  // Prioritaskan pencarian langsung dari pesan pengguna terkini agar riwayat bot sebelumnya tidak mengontaminasi kata kunci
  let ragContext = ragEngine.buildContext(message);

  // Jika pesan pengguna sangat pendek (referensi dialog lanjutan seperti "berapa harganya?"), gunakan konteks pertanyaan user sebelumnya
  if (!ragContext && history.length > 0) {
    const prevUserQueries = history
      .filter(h => h.role === "user")
      .slice(-2)
      .map(h => h.content)
      .join(" ");
    ragContext = ragEngine.buildContext(`${prevUserQueries} ${message}`);
  }

  // 7. Panggil Groq AI untuk Pertanyaan Produk / Informasi Lanjutan
  try {
    if (!groq) {
      // Inisialisasi ulang jika API key baru saja diset
      if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      } else {
        return "Halo! Terima kasih telah menghubungi kami. Saat ini sistem sedang dalam mode offline atau API Key Groq belum dikonfigurasi pada file .env.";
      }
    }

    const systemPrompt = `Anda adalah konsultan perhiasan resmi dari "Aura Jewelry & Gold Atelier", toko perhiasan dan emas terpercaya. Jawab dalam Bahasa Indonesia yang ramah, hangat, natural, to the point, dan sangat rapi.

PRINSIP KEAKURATAN DATA PRODUK (BERPIJAK KETAT PADA KATALOG RESMI):
1. Keaslian & Kebenaran Data:
   - Jawab HANYA berdasarkan informasi produk resmi yang tertera pada Konteks Katalog di bawah.
   - JANGAN PERNAH mengarang, berspekulasi, atau berasumsi tentang spesifikasi, varian warna, atau bahan yang tidak ada di katalog.
   - JANGAN PERNAH mencampuradukkan deskripsi antar produk (misal: "pengait emas" adalah milik Kalung Mutiara Air Laut, BUKAN milik Kalung Emas).
   - Karakteristik material perhiasan resmi toko:
     • *Gelang Emas*, *Cincin Emas*, *Kalung Emas*, *Anting Emas*: Material emas kuning klasik asli berkilau elegan.
     • *Gelang Berlian Charm*: Rantai emas putih dengan liontin berlian mungil.
     • *Cincin Kawin Platinum*: Bahan platinum anti karat yang elegan dan tahan lama.
     • *Kalung Mutiara Air Laut*: Mutiara air laut asli kilau alami dengan pengait emas.
     • *Anting Permata Safir*: Permata safir biru royal dengan bingkai emas kuning.
2. Jangan Pernah Memecah Karakter (No Fourth-Wall Breaking):
   - JANGAN PERNAH menyebut istilah internal/sistem seperti: "di file CSV", "deskripsi katalog tertulis secara umum", "di sistem kami...", atau "karena deskripsi tidak menyebutkan...".
   - Tampil selayaknya konsultan perhiasan profesional toko yang percaya diri dan memahami koleksi tokonya.
3. Jawab Ringkas, To-The-Point & Jangan Menguliahi:
   - Jawab pertanyaan spesifik (misal warna, harga, atau ukuran) secara langsung dalam 1-2 paragraf singkat.
   - JANGAN memberikan kuliah atau penjelasan teoritis panjang tentang emas.
   - Jika pelanggan menanyakan varian khusus, dimensi fisik (seperti diameter, berat), atau hal di luar katalog, jangan gunakan kata "hubungi tim kami", melainkan sertakan informasi kontak resmi toko secara langsung.

ATURAN PENGGANTIAN FRASA "TIM KAMI" / "CUSTOMER SERVICE" (SANGAT PENTING):
- DILARANG KERAS menggunakan kalimat generik seperti:
  ❌ "hubungi tim kami"
  ❌ "tanyakan ke tim kami"
  ❌ "konfirmasi ke tim toko"
  ❌ "silakan hubungi tim kami melalui WhatsApp"
  ❌ "hubungi admin / customer service"
- SETIAP KALI pelanggan menanyakan informasi spesifik yang tidak tersedia di katalog (seperti detail dimensi fisik, diameter permata, berat gramasi, kustomisasi ukuran/warna, atau stok terkini), SELALU GANTI dengan menampilkan rincian *Informasi Kontak Toko* secara lengkap:
  📍 *Alamat:* Jl. Perhiasan No. 88, Pusat Emas & Permata, Jakarta
  📞 *Telepon / WA:* (021) 555-0199 / Chat WhatsApp ini
  ⏰ *Jam Operasional:* Senin - Sabtu (09.00 - 20.00 WIB), Minggu (10.00 - 17.00 WIB)

ATURAN SALAM & KATA "SELAMAT DATANG":
1. Penggunaan Kata "Selamat Datang":
   - HANYA ucapkan sapaan pembuka "Selamat datang di Aura Jewelry & Gold Atelier" jika pesan pelanggan berupa salam/sapaan awal (misal: "halo", "hai", "selamat pagi") DAN belum ada percakapan sebelumnya.
   - Jika percakapan SUDAH BERLANGSUNG (ada riwayat obrolan di atas) ATAU pesan pelanggan langsung menanyakan produk/hal lain (misal: "apa saja produknya", "warna kalung emas apa aja"), JANGAN PERNAH mengulangi kata "Selamat datang di...". Langsung jawab inti pertanyaan secara natural dan ramah.
2. Jika Pesan Pengguna HANYA Berupa Sapaan (misal: "halo", "hai", "hi", "pagi", "ping"):
   - Balas dengan sapaan ramah, hangat, dan natural (contoh: "Halo! Selamat datang di *Aura Jewelry & Gold Atelier*. ✨ Ada yang bisa kami bantu seputar koleksi perhiasan kami hari ini?").
   - DILARANG KERAS menggunakan frasa kaku atau aneh seperti:
     ❌ "Saya asisten virtual resmi kami"
     ❌ "Saya adalah bot virtual"
     ❌ "Saya asisten AI Anda"
   - Berbicaralah selayaknya konsultan perhiasan toko manusiawi yang santun dan profesional.
   - JANGAN PERNAH menampilkan daftar produk atau katalog jika pengguna HANYA menyapa.

PANDUAN FORMAT TAMPILAN WHATSAPP:
1. Format Teks WhatsApp:
   - Gunakan SATU bintang untuk cetak tebal, contoh: *teks tebal* (JANGAN gunakan dua bintang **teks**).
   - Gunakan bullet point (•) untuk mendaftar produk.
   - Gunakan emoji yang elegan (✨, 💎, 💍, 🏷️, 📍, 📞, ⏰) secukupnya untuk memberi aksen visual.
2. JANGAN PERNAH menggabungkan daftar produk ke dalam satu paragraf panjang yang padat. Setiap produk WAJIB ditulis terpisah dalam baris baru.
3. Jika pelanggan meminta "semua produk" atau "katalog", kelompokkan berdasarkan kategori (*Koleksi Gelang*, *Koleksi Cincin*, *Koleksi Kalung*, *Koleksi Anting*) lengkap dengan harga dan deskripsinya.
4. Pastikan seluruh kalimat jawaban dan kalimat penutup diselesaikan secara tuntas dan tidak terpotong di tengah kalimat.
5. Jika pelanggan menanyakan produk di luar katalog, jawab sopan dan sertakan kontak toko resmi:
   📍 *Alamat:* Jl. Perhiasan No. 88, Pusat Emas & Permata, Jakarta
   📞 *Telepon / WA:* (021) 555-0199 / Chat WhatsApp ini
   ⏰ *Jam Operasional:* Senin - Sabtu (09.00 - 20.00 WIB), Minggu (10.00 - 17.00 WIB)

${ragContext ? ragContext : "Konteks Katalog: (Tidak ada katalog produk yang diminta pada pertanyaan ini. Jika pelanggan hanya menyapa, jawab sapaan saja dengan ramah)."}`;

    // Susun pesan: system prompt + riwayat obrolan sebelumnya + pesan user terkini
    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    const candidateModels = [
      process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "allam-2-7b"
    ];

    let lastError = null;
    for (const modelName of candidateModels) {
      try {
        const { data: completion, response } = await groq.chat.completions.create({
          model: modelName,
          messages: messagesPayload,
          max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1500)
        }).withResponse();

        if (response && response.headers) {
          updateGroqQuotaFromHeaders(response.headers, modelName);
        }

        if (completion.choices && completion.choices[0] && completion.choices[0].message) {
          const rawAiReply = completion.choices[0].message.content;
          const aiReply = formatWhatsAppMessage(rawAiReply);
          if (senderId) {
            appendUserHistory(senderId, message, aiReply);
          }
          return aiReply;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Groq Model ${modelName}] Gagal: ${err.message}. Mencoba model alternatif...`);
      }
    }

    throw lastError || new Error("Semua model Groq gagal merespon.");
  } catch (error) {
    console.error("Error Groq API:", error.message || error);
    if (ragContext) {
      // Fallback jika Groq error tetapi ada data RAG
      return formatWhatsAppMessage(`Halo! ✨ Berikut informasi produk dari katalog kami:\n\n${ragContext}\nAda yang bisa kami bantu seputar produk di atas? 😊`);
    }
    return formatWhatsAppMessage(`Halo! ✨ Terima kasih telah menghubungi *Aura Jewelry & Gold Atelier*.\n\nKami menyediakan berbagai koleksi perhiasan emas dan permata seperti *Gelang*, *Cincin*, *Kalung*, dan *Anting*.\n\nAda yang bisa kami bantu seputar informasi produk atau pemesanan hari ini? 😊`);
  }
}

// Helper Masking Nomor Telepon (Format: 08xxxxxx4digit)
function maskPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let formatted = String(rawNumber).replace(/^62/, "08");
  if (formatted.length >= 8) {
    const prefix = formatted.slice(0, 2); // "08"
    const suffix = formatted.slice(-4);   // 4 digit terakhir
    const maskedLength = formatted.length - 6;
    return `${prefix}${"x".repeat(maskedLength)}${suffix}`;
  }
  return formatted;
}

// ================= API ENDPOINTS =================

// Status Bot
app.get("/api/bot/status", (req, res) => {
  let botNumber = null;
  if (isReady && client && client.info && client.info.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }

  res.json({
    isReady,
    isInitializing,
    isCleaning,
    hasQRCode: Boolean(qrCodeData),
    botNumber
  });
});

// Kuota & Rate Limit Groq AI
app.get("/api/groq/quota", async (req, res) => {
  try {
    const isFresh = req.query.fresh === "true" || groqQuota.remainingRequests === null;
    if (isFresh) {
      await fetchGroqQuotaFresh();
    }
    res.json(groqQuota);
  } catch (err) {
    console.error("Error cek kuota Groq:", err);
    res.status(500).json({ error: err.message, ...groqQuota });
  }
});

// QR Code Data
app.get("/api/bot/qr", (req, res) => {
  res.json({ qr: qrCodeData });
});

// Start Bot
app.post("/api/bot/start", async (req, res) => {
  try {
    if (isReady) {
      return res.json({ success: true, message: "Bot sudah berjalan." });
    }
    if (isInitializing) {
      return res.json({ success: true, message: "Bot sedang proses inisialisasi..." });
    }

    isInitializing = true;
    const waClient = initializeClient();
    await waClient.initialize();
    res.json({ success: true });
  } catch (err) {
    isInitializing = false;
    console.error("Gagal memulai bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop Bot
app.post("/api/bot/stop", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    qrCodeData = null;
    if (client) {
      await client.destroy();
    }
    client = null;
    isCleaning = false;
    res.json({ success: true });
  } catch (err) {
    isCleaning = false;
    console.error("Gagal menghentikan bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Sesi WhatsApp (Hapus sesi yang nyangkut / logout)
app.post("/api/bot/reset", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;

    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.warn("Peringatan saat destroy client:", e.message);
      }
      client = null;
    }

    const authDir = path.join(__dirname, ".wwebjs_auth");
    const cacheDir = path.join(__dirname, ".wwebjs_cache");

    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("[Reset Session]: Folder .wwebjs_auth berhasil dihapus");
    }
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log("[Reset Session]: Folder .wwebjs_cache berhasil dihapus");
    }

    conversationHistory.clear();
    console.log("[Reset Session]: Seluruh riwayat obrolan berhasil dibersihkan");

    isCleaning = false;
    res.json({ success: true, message: "Sesi WhatsApp berhasil dibersihkan. Anda dapat memindai QR baru." });
  } catch (err) {
    isCleaning = false;
    console.error("Gagal mereset sesi bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ambil data Basis Pengetahuan
app.get("/api/knowledge", (req, res) => {
  loadKnowledge();
  res.json(knowledge);
});

// Ambil daftar produk CSV
app.get("/api/products", (req, res) => {
  ragEngine.loadData();
  res.json({ products: ragEngine.products });
});

// Jalankan Server
const server = app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  if (process.env.AUTO_START_BOT === "true") {
    console.log("AUTO_START_BOT aktif, memulai inisialisasi bot WhatsApp...");
    isInitializing = true;
    const waClient = initializeClient();
    waClient.initialize().catch(err => {
      isInitializing = false;
      console.error("Auto start gagal:", err);
    });
  }
});

// Penutupan bersih saat server dihentikan (mencegah Chrome nyangkut)
async function gracefulShutdown(signal) {
  console.log(`\nMenerima sinyal ${signal}, membersihkan proses...`);
  if (client) {
    try {
      await client.destroy();
      console.log("Koneksi WhatsApp & browser Chrome berhasil ditutup.");
    } catch (e) {
      // Abaikan jika sudah tertutup
    }
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

