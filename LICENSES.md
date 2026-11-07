# Third-party assets

This application includes the following unmodified, pinned browser assets. Runtime scripts and models are served from this application's own origin; no CDN is required while using the app.

| Asset | Version | Upstream | License file |
| --- | --- | --- | --- |
| face-api.js browser bundle | 0.22.2 | [justadudewhohacks/face-api.js](https://github.com/justadudewhohacks/face-api.js/tree/0.22.2) | [MIT](licenses/face-api-LICENSE.txt) |
| Tiny Face Detector, 68-point face landmarks, face recognition weights distributed with face-api.js | 0.22.2 repository assets | [Upstream weights](https://github.com/justadudewhohacks/face-api.js/tree/0.22.2/weights) | [Repository MIT license](licenses/face-api-LICENSE.txt) |
| TensorFlow.js core, bundled in face-api.js | 1.7.0 | [tensorflow/tfjs](https://github.com/tensorflow/tfjs/tree/tfjs-core-v1.7.0) | [Apache-2.0](licenses/tensorflowjs-LICENSE.txt) |
| tslib helpers, bundled in face-api.js | 1.11.1-era dependency | [microsoft/tslib](https://github.com/microsoft/tslib/tree/1.11.1) | [License](licenses/tslib-LICENSE.txt), [copyright notice](licenses/tslib-CopyrightNotice.txt) |
| fflate browser UMD | 0.8.2 | [101arrowz/fflate](https://github.com/101arrowz/fflate/tree/v0.8.2) | [MIT](licenses/fflate-LICENSE.txt) |
| exifr full browser UMD | 7.1.3 | [MikeKovarik/exifr](https://github.com/MikeKovarik/exifr/tree/v7.1.3) | [MIT](licenses/exifr-LICENSE.txt) |

`asset-lock.json` records each asset's upstream URL, byte size, and SHA-256 digest. The digests were calculated from the downloaded upstream files. The fflate and exifr npm package tarballs were additionally verified against their published npm SHA-512 integrity values before extracting the exact UMD and license files.

face-api.js is copyright 2018 Vincent Mühler; fflate is copyright 2023 Arjun Barrett; exifr's copyright notice is retained in its license file. The complete licenses and notices are distributed in the `licenses/` directory.
