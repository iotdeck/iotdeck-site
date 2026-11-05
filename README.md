<p align="center">
  <img src="public/logo.svg" width="96" alt="IoTDeck logo">
</p>

<h1 align="center">IoTDeck</h1>

<p align="center">
  Free, open source IoT dashboards for DIY students and makers.<br>
  See your ESP32's sensor readings live, and control your board from any browser.
</p>

<p align="center">
  <a href="https://iotdeck.org">Website</a> ·
  <a href="https://iotdeck.org/signin">Create a free account</a>
</p>

---

## Why IoTDeck

Building an IoT project should not require paying for a cloud platform. IoTDeck gives students and hobbyists a ready-made web dashboard for their boards, so the focus stays on learning how devices talk to the web.

- **Free for students.** Creating devices and dashboards costs nothing.
- **Learn by building.** Connect a real ESP32, see its data within seconds, and understand the path from sensor to screen.
- **Open to the community.** The code is public. Read it, change it, and improve it with other makers.

## What you can do

- **Live readings:** temperature, humidity, or any value your board sends, updated as it arrives.
- **Control your board:** switches, buttons, and sliders send commands back to the device.
- **Gadgets:** value, text, gauge, progress bar, live chart, and status lamp for readings; switch, button, and slider for control.
- **Your own look:** each device gets its own page, accent colour, background preset, or uploaded background image.

## How it works

1. **Create a device** on your dashboard. You get a key that is shown only once.
2. **Connect your board.** Paste the key into the ESP32 sketch and upload it.
3. **Build your dashboard.** Add gadgets for readings and controls, then customise the look.

## Project structure

| Folder | Contents |
| --- | --- |
| `public/` | The website: landing page, sign-in, and dashboard (plain HTML, CSS and JavaScript). |
| `functions/` | Server routes for the Cloudflare Worker. |
| `lib/` | Shared server code: accounts, devices, widgets, themes and background images. |

## Running it yourself

IoTDeck runs on Cloudflare Workers with D1 (database), R2 (background images) and a Durable Object for live device connections.

1. Create a Cloudflare account and a D1 database, then set the IDs in `wrangler.toml`.
2. Create an R2 bucket and set its name in `wrangler.toml`.
3. Add the Google sign-in secret with `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
4. Deploy with `npx wrangler deploy`.

## Status

IoTDeck is in active development. The core dashboard, device pages, gadgets and background images are working. Free-form layout of gadgets is not yet available.

## License

Not yet licensed. The code is public to read, but no licence for reuse has been chosen yet.

## Made with Bala Code

<p align="center">
  <img src="assets/bala-code-logo.png" width="96" alt="Bala Code logo">
</p>

IoTDeck is shared by [Bala Code | بلا كود](https://balacode.org), an Arabic channel that teaches beginners to build useful services with AI tools, for free.
