# Cedar Staff branding

The blue-and-white geometric cross reuses the project's existing Cedar Staff
header and launcher artwork. No downloaded image, font or third-party artwork
is used. Existing dependency and other asset license notices remain unchanged.

`cedar-staff.ico` contains transparent 32-bit Windows images at 16, 24, 32, 48,
64, 128 and 256 pixels. Regenerate from the existing shared artwork source with:

```sh
node apps/staff/scripts/generate-branding.js
```

The application and launcher use this local asset; the shortcut uses the same
generator. Executable resource branding is not code signing or trusted distribution.
