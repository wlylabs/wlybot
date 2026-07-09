<div align="center">
  <img src="favicon.svg" alt="Logo Wlybot" width="88" height="88">
  <h1>Wlybot</h1>
  <p>Chatbot AI mobile-first yang siap deploy ke Vercel.<br>
  Tanpa framework, tanpa build step, tanpa dependency.</p>

  [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fwlylabs%2Fwlybot&env=GROQ_API_KEY&envDescription=API%20key%20Groq%20(provider%20utama).%20Gemini%20dan%20OpenRouter%20opsional%20sebagai%20fallback.&envLink=https%3A%2F%2Fconsole.groq.com%2Fkeys)
  [![License: MIT](https://img.shields.io/badge/License-MIT-6c7bff.svg)](LICENSE)

</div>

## Fitur

- **Multi-provider dengan fallback otomatis** — Groq sebagai provider utama; jika gagal (rate limit, gangguan, key invalid), server berpindah sendiri ke Gemini, lalu OpenRouter, dalam satu request.
- **Web search (opsional)** — set `TAVILY_API_KEY` dan bot bisa mencari di web lewat tool calling: model memanggil tool `web_search` untuk berita, harga, cuaca, atau fakta terkini, lalu menjawab berdasarkan hasilnya lengkap dengan link sumber. Tanpa key ini bot berperilaku seperti biasa (mengaku tidak bisa memverifikasi info terkini).
- **Streaming** — respons mengalir kata per kata, bisa dihentikan kapan saja.
- **Multi-percakapan** — banyak chat sekaligus dengan judul otomatis; buat, buka kembali, dan hapus percakapan dari sheet riwayat. Semua tersimpan di perangkat (localStorage), bukan di server.
- **Regenerate & copy** — ulangi jawaban terakhir dengan satu ketukan, salin seluruh jawaban atau blok kode saja.
- **Input suara** — dikte pesan lewat Web Speech API (mengikuti bahasa perangkat), tanpa server tambahan.
- **Ekspor chat** — unduh percakapan aktif sebagai file Markdown.
- **Mobile-first** — dark theme terminal, bottom sheet, dukungan safe area (notch), tidak memicu auto-zoom iOS, dan installable sebagai PWA di home screen.
- **API key aman** — semua key disimpan di environment variable Vercel dan hanya dibaca di Edge Function. Browser tidak pernah menerima key.
- **Persona yang konsisten** — hangat, jujur soal ketidakpastian, langsung ke inti, memakai aku-kamu dalam bahasa Indonesia, tanpa emoji kecuali diminta.

## Arsitektur

```
Browser (index.html)
   |  POST /api/chat  { messages, provider }
   v
Vercel Edge Function (api/chat.js)
   |  coba berurutan sampai satu berhasil:
   |  1. Groq        llama-3.3-70b-versatile
   |  2. Gemini      gemini-2.5-flash
   |  3. OpenRouter  meta-llama/llama-3.3-70b-instruct:free
   v
Stream teks polos kembali ke browser
```

| File | Peran |
|---|---|
| `index.html` | UI chat statis: render markdown ringan, streaming, multi-percakapan, voice input, ekspor, pengaturan provider |
| `api/chat.js` | Edge Function: validasi, fallback provider, agent loop (tool calling + web search), normalisasi SSE menjadi stream teks |
| `favicon.svg` + `icon-*.png` | Logo dan ikon aplikasi |
| `site.webmanifest` | Metadata PWA |
| `vercel.json` | Security headers |

## Deploy

1. Klik tombol **Deploy with Vercel** di atas, atau import repo ini di [vercel.com/new](https://vercel.com/new) dengan preset **Other** (tanpa build command).
2. Di **Settings → Environment Variables**, tambahkan API key. `GROQ_API_KEY` disarankan sebagai minimum; tambahkan yang lain agar fallback aktif:

   | Variable | Peran | Dapatkan dari |
   |---|---|---|
   | `GROQ_API_KEY` | Provider utama | [console.groq.com/keys](https://console.groq.com/keys) |
   | `GEMINI_API_KEY` | Fallback pertama | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
   | `OPENROUTER_API_KEY` | Fallback kedua | [openrouter.ai/keys](https://openrouter.ai/keys) |
   | `TAVILY_API_KEY` | Web search (opsional) | [app.tavily.com](https://app.tavily.com) — ada free tier |

3. Redeploy setelah menambah atau mengubah environment variable — Vercel tidak menerapkannya ke deployment yang sudah berjalan.

### Mengganti model (opsional)

| Variable | Default | Catatan |
|---|---|---|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Model produksi Groq, cepat dan seimbang |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Generasi Flash terbaru yang GA |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` | Free tier; ganti ke model berbayar untuk kuota lebih besar |

## Pengembangan lokal

```bash
npm i -g vercel
vercel dev
```

Simpan key di `.env.local` (sudah ada di `.gitignore`, jangan di-commit):

```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
```

## Keamanan

- API key hanya dibaca di server (Edge Function); frontend tidak pernah menerima atau mengirim key.
- Endpoint membatasi konteks ke 40 pesan terakhir dan 32.000 karakter per pesan.
- Security headers (nosniff, frame deny, referrer policy) diterapkan lewat `vercel.json`.
- Endpoint bersifat publik mengikuti URL deployment. Jika dibagikan luas, tambahkan proteksi sendiri (mis. Vercel Firewall, rate limiting, atau autentikasi).

## Lisensi

[MIT](LICENSE)
