// Which library this site reads and autosaves to. The deployed site uses the Hugging Face dataset
// below; library_server.py (on localhost) uses the files in data/<lang>/ on disk instead.
// To add a language, publish it with publish_hf.py and change `lang` (or add a picker).
window.RSML_BENCH = { dataset: "openbhasha/rsml-bench", lang: "telugu" };
