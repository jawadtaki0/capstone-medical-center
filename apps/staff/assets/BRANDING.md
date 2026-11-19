# Cedar Staff branding

The Cedar symbol is cropped from the approved bilingual lockup shared by the
website and Staff. The icon contains the mark alone, without either wordmark.

`cedar-staff.ico` contains transparent 32-bit Windows images at 16, 24, 32, 48,
64, 128 and 256 pixels. Sync this icon to the website favicon with:

```sh
node apps/staff/scripts/generate-branding.js
```

The executable, Staff window, launcher window and shortcut all use this local
asset. Executable resource branding does not sign the binary.
