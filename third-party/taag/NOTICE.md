# TAAG TheDraw renderer — local personal build

Source: https://patorjk.com/software/taag/
Author: patorjk. Retrieved 2026-09-29, bundle index-BJbq3q41.js.

The full standalone TheDraw parsing/rendering module is extracted from the public client bundle, with its code unchanged apart from formatting and named exports. It supports cells, plain text, ANSI and HTML output and outline, block and colour font parsing. Site UI, tracking, analytics and network loading code are not included.

The author explicitly permits this kind of personal local use in the 8 August 2026 reply at https://patorjk.com/blog/2026/07/17/adding-thedraw-fonts-to-taag/ . This is not an open-source redistribution licence for the website or its font archive. Keep this personal build separate from any public distribution pending permission or a licensed replacement. The linked discussion also identifies the old TDF files' redistribution rights as uncertain; no broader rights are claimed here.

Font data retains the original TheDraw file contents. The default is PE Red with the requested three lines: tris / magi / stus. Bundled font filenames, hashes and source metadata are recorded in manifest.json. One source file, tdf-chunk-25.tdf, returned HTTP 406 and its entries are omitted from the local selector. The complete rendering engine and all six PE variants are present. No font or code is downloaded at app runtime.
