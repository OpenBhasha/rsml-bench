// Which library this site reads and autosaves to. The deployed site uses the Hugging Face dataset
// below; library_server.py (on localhost) uses the files in data/<lang>/ on disk instead.
// To add a language, publish it with publish_hf.py and change `lang` (or add a picker).
window.RSML_BENCH = { dataset: "openbhasha/rsml-bench", lang: "telugu" };

// Original IndicConformer drafts and the tasks seeded by that upload.
window.RSML_BENCH.asrDraftRevision = "1ef96e6f580e79d2d056393959072adfb838a952";
window.RSML_BENCH.asrDraftIds = [
  "-vyuLcHDt3s", "07uoo584-hQ", "2zw9wLynL8Y", "43_ld0KpqIM", "ABVPVV3C96w",
  "EGp79Cv9_gI", "FUgm2ptxvYs", "GIxdQGSsvZA", "GWUsFs-gqFc", "HRZ3WdMtJlw",
  "JmLDdqvQ3C8", "KN_kSuhNzIE", "Mzhq7Ifi8CU", "OT5W1w2Inuc", "PzaSIXWVOEU",
  "W-bTbIeobY0", "Y5rFAlfHXNA", "aFIwxlgBgCI", "ka1SMQKcDO0", "nLQVdYYchro",
  "oc1mzajW-B8", "rARHBy-ZI6A", "tjk9MOscaiE", "v0g_uYkBZE8", "vU_GZlvaQ54",
  "wikCc-LBsDc", "zjp-RZcjWn4",
];
