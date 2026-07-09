# Wlybot

Chatbot AI mobile-first yang siap deploy ke Vercel. Tanpa framework, tanpa build step, tanpa dependency — hanya satu halaman HTML dan satu Vercel Edge Function.

## Fitur

- UI mobile-first: dark theme, bottom sheet pengaturan, aman untuk notch (safe area), tidak memicu auto-zoom di iOS.
- Streaming respons kata per kata.
- Tiga provider AI dalam satu endpoint: **Groq**, **Google Gemini**, dan **OpenRouter**. Pilih manual lewat pengaturan, atau mode otomatis (memakai provider pertama yang API key-nya terpasang).
- API key disimpan di environment variable Vercel — tidak pernah menyentuh browser pengguna.
- Riwayat percakapan tersimpan di perangkat (localStorage).
- Persona percakapan yang hangat, jujur, dan langsung ke inti.

## Struktur

```
index.html      UI chat (statis, tanpa build)
api/chat.js     Edge Function: menerima pesan, memanggil provider, stream balik teks
```

## Deploy ke Vercel

1. Push repo ini ke GitHub, lalu import di [vercel.com/new](https://vercel.com/new). Framework preset: **Other**. Tidak perlu build command.
2. Buka **Settings → Environment Variables** di project Vercel, lalu tambahkan minimal satu API key:

   | Variable | Wajib | Dapatkan dari |
   |---|---|---|
   | `GROQ_API_KEY` | salah satu | [console.groq.com/keys](https://console.groq.com/keys) |
   | `GEMINI_API_KEY` | salah satu | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
   | `OPENROUTER_API_KEY` | salah satu | [openrouter.ai/keys](https://openrouter.ai/keys) |

3. (Opsional) Ganti model default:

   | Variable | Default |
   |---|---|
   | `GROQ_MODEL` | `llama-3.3-70b-versatile` |
   | `GEMINI_MODEL` | `gemini-2.0-flash` |
   | `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` |

4. Redeploy setelah menambah/mengubah environment variable (Vercel tidak menerapkannya ke deployment yang sudah jalan).

## Jalankan lokal

```bash
npm i -g vercel
vercel dev
```

Set environment variable lewat file `.env.local` (jangan di-commit):

```
GROQ_API_KEY=gsk_...
```

## Keamanan

- API key hanya dibaca di server (Edge Function). Frontend tidak pernah menerima atau mengirim key.
- Endpoint membatasi konteks ke 40 pesan terakhir dan 32.000 karakter per pesan.
- Jika ingin membatasi pemakaian publik, tambahkan proteksi sendiri (mis. Vercel Firewall atau autentikasi) sebelum membagikan URL.
