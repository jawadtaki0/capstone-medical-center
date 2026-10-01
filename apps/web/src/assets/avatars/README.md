# Supplied professional avatars

`professional-silhouettes.png` is the original combined male/female silhouette
artwork supplied by the project owner on 2026-10-01. The owner confirms the supplied
assets are open-source and licensed for use. No separate license text or named
attribution accompanied this image; no independent license identification is claimed.

The original file is preserved byte-for-byte, including its visible watermarks.
CSS frames display the left or right silhouette without editing the source image
or removing marks. Do not remove watermarks or any later supplied attribution.

The public directory API supplies a derived `avatarVariant` of `male`, `female`,
or `neutral`. The frontend chooses the supplied silhouette from that enum, not
from a duplicated profile-ID list, name, specialty, initials, or raw gender data.
Missing or unsupported variants use the neutral medical-symbol presentation;
an unavailable image uses the same decorative fallback without changing the
professional's visible name or specialty.
