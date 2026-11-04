// Fixed educational content paraphrased from the linked MedlinePlus sources.
// Availability and facility protocols are not verified by this catalogue.
export const laboratoryTests = [
  {
    id: "cbc",
    name: "Complete blood count (CBC)",
    category: "Blood and clotting",
    aliases: ["full blood count", "FBC"],
    sample: "blood",
    description: "Measures several types and features of blood cells.",
    preparation:
      "A CBC alone usually needs no special preparation; other tests collected at the same time may have different instructions.",
    question: "Do I need to fast for a CBC?",
    answer: "Usually not for the CBC itself; check the complete test order.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/complete-blood-count-cbc/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "esr",
    name: "Erythrocyte sedimentation rate (ESR)",
    category: "Blood and clotting",
    aliases: [],
    sample: "blood",
    description:
      "Measures how quickly red blood cells settle, as one indicator of inflammation.",
    preparation: "No special preparation is generally needed for ESR alone.",
    question: "Does ESR require fasting?",
    answer:
      "Not usually by itself; follow instructions for any accompanying tests.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/erythrocyte-sedimentation-rate-esr/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "crp",
    name: "C-reactive protein (CRP)",
    category: "Blood and clotting",
    aliases: [],
    sample: "blood",
    description: "Measures a protein that rises in response to inflammation.",
    preparation:
      "Tell your clinician about medicines and supplements that may affect the measurement. Confirm any preparation for tests ordered together.",
    question: "Is this the same as hs-CRP?",
    answer: "No; the high-sensitivity test is used for a different purpose.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/c-reactive-protein-crp-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "pt-inr",
    name: "Prothrombin time / INR (PT/INR)",
    category: "Blood and clotting",
    aliases: ["PT", "pro time"],
    sample: "blood",
    description:
      "Measures clotting time, with INR providing a standardized comparison.",
    preparation:
      "Tell the clinician about anticoagulants and follow their specific medicine-timing instructions.",
    question: "Should I change my blood thinner before testing?",
    answer:
      "Do not change it yourself; obtain instructions from the clinician managing it.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/prothrombin-time-test-and-inr-ptinr/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "aptt",
    name: "Activated partial thromboplastin time (aPTT)",
    category: "Blood and clotting",
    aliases: ["PTT", "partial thromboplastin time"],
    sample: "blood",
    description: "Measures another part of the blood-clotting process.",
    preparation:
      "Usually no special preparation is required for the test itself.",
    question: "Should I mention anticoagulant treatment?",
    answer: "Yes; report your medicines without changing them on your own.",
    sources: [
      {
        label: "Test source",
        url: "https://medlineplus.gov/lab-tests/partial-thromboplastin-time-ptt-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "fasting-glucose",
    name: "Fasting blood glucose",
    category: "Glucose and cholesterol",
    aliases: ["FBG", "FBS", "FPG"],
    sample: "blood",
    description: "Measures blood glucose after a prescribed fasting period.",
    preparation:
      "For a fasting glucose test, the reference describes at least eight hours of fasting; confirm the exact instructions for your order. Plain water is generally allowed unless instructed otherwise.",
    question: "Is this the same as random glucose?",
    answer: "No; this catalogue entry specifically describes the fasting test.",
    sources: [
      {
        label: "Test source",
        url: "https://medlineplus.gov/lab-tests/blood-glucose-test/",
      },
      {
        label: "Fasting guidance",
        url: "https://medlineplus.gov/lab-tests/fasting-for-a-blood-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "hba1c",
    name: "Hemoglobin A1c (HbA1c)",
    category: "Glucose and cholesterol",
    aliases: ["A1c", "glycated hemoglobin"],
    sample: "blood",
    description:
      "Reflects average blood glucose over approximately the previous two to three months.",
    preparation: "Fasting is not normally needed for HbA1c alone.",
    question: "What if other blood tests were ordered too?",
    answer: "Follow their preparation instructions as well.",
    sources: [
      {
        label: "Preparation source",
        url: "https://medlineplus.gov/ency/article/003640.htm",
      },
      {
        label: "description source",
        url: "https://medlineplus.gov/lab-tests/hemoglobin-a1c-hba1c-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "lipid-panel",
    name: "Lipid panel",
    category: "Glucose and cholesterol",
    aliases: ["cholesterol test", "lipid profile"],
    sample: "blood",
    description: "Measures cholesterol and triglycerides.",
    preparation:
      "You may be asked to fast; whether fasting is needed and for how long must come from your clinician/laboratory.",
    question: "Must everyone fast for this test?",
    answer:
      "Do not assume so; confirm the instructions for your particular order.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/cholesterol-levels/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "creatinine",
    name: "Creatinine",
    category: "Kidney and electrolytes",
    aliases: [],
    sample: "blood",
    description:
      "Measures a waste product used in assessing kidney filtration.",
    preparation:
      "Instructions may include restrictions on meat or fasting when combined with other tests; ask before the visit.",
    question: "Is a urine sample always needed?",
    answer:
      "This entry describes blood creatinine; urine collections are separate tests and require their own instructions.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/creatinine-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "bun",
    name: "Blood urea nitrogen (BUN)",
    category: "Kidney and electrolytes",
    aliases: [],
    sample: "blood",
    description: "Measures nitrogen in a waste product cleared by the kidneys.",
    preparation:
      "Usually no special preparation for BUN alone; accompanying tests may require fasting.",
    question: "Can combined tests change preparation?",
    answer: "Yes; use the instructions for the whole order.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/bun-blood-urea-nitrogen/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "electrolyte-panel",
    name: "Electrolyte panel",
    category: "Kidney and electrolytes",
    aliases: [],
    sample: "blood",
    description:
      "Measures minerals involved in fluid balance and normal body function.",
    preparation:
      "Usually no special preparation is needed for the electrolyte panel itself.",
    question: "What if this is part of a larger panel?",
    answer: "Confirm whether that panel has additional preparation.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/electrolyte-panel/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "alt",
    name: "Alanine aminotransferase (ALT)",
    category: "Liver-related tests",
    aliases: ["alanine transaminase", "SGPT"],
    sample: "blood",
    description: "Measures an enzyme used in liver assessment.",
    preparation:
      "ALT is often collected with other tests that may need fasting. Report medicines and ask for the instructions for your complete order.",
    question: "Should I fast for ALT?",
    answer:
      "Confirm with the laboratory rather than assuming a rule for every ALT order.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/alt-blood-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "ast",
    name: "Aspartate aminotransferase (AST)",
    category: "Liver-related tests",
    aliases: ["aspartate transaminase", "SGOT"],
    sample: "blood",
    description: "Measures an enzyme found in the liver and other tissues.",
    preparation:
      "Combined testing may require fasting; follow the clinician's instructions and report medicines.",
    question: "Does this measure only the liver?",
    answer:
      "AST is also present in other tissues; results need clinical interpretation.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/ast-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "alp",
    name: "Alkaline phosphatase (ALP)",
    category: "Liver-related tests",
    aliases: [],
    sample: "blood",
    description:
      "Measures an enzyme associated with several tissues, including liver and bone.",
    preparation:
      "The clinician may give fasting instructions, especially with other ordered tests.",
    question: "Is a single fasting rule used for every ALP order?",
    answer: "No; confirm your specific preparation.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/alkaline-phosphatase/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "bilirubin",
    name: "Bilirubin blood test",
    category: "Liver-related tests",
    aliases: [],
    sample: "blood",
    description:
      "Measures a pigment formed during the normal breakdown of red blood cells.",
    preparation:
      "Fasting may be requested; medicines can affect testing, so discuss them without changing them yourself.",
    question: "Do I automatically need to fast?",
    answer: "Follow the instructions given for your order.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/bilirubin-blood-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "tsh",
    name: "Thyroid-stimulating hormone (TSH)",
    category: "Thyroid, iron and vitamins",
    aliases: [],
    sample: "blood",
    description: "Measures a hormone used to assess thyroid function.",
    preparation:
      "Report medicines/supplements; accompanying tests may introduce fasting requirements.",
    question: "Should I alter thyroid medicine timing?",
    answer:
      "Ask your prescribing clinician; this page does not set medicine schedules.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/tsh-thyroid-stimulating-hormone-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "free-t4",
    name: "Free thyroxine (free T4)",
    category: "Thyroid, iron and vitamins",
    aliases: ["FT4", "free thyroxine"],
    sample: "blood",
    description: "Measures the unbound form of a thyroid hormone.",
    preparation:
      "Usually no special preparation for T4 alone; medicines/supplements and combined tests may affect instructions.",
    question: "Is free T4 the same as total T4?",
    answer: "They are different measurements; use the exact test ordered.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/thyroxine-t4-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "ferritin",
    name: "Ferritin",
    category: "Thyroid, iron and vitamins",
    aliases: [],
    sample: "blood",
    description: "Measures a protein associated with stored iron.",
    preparation:
      "Fasting may be requested; obtain the duration and timing from the clinician/laboratory.",
    question: "Is fasting ever needed?",
    answer:
      "Yes, it may be requested; do not assume ferritin always needs no preparation.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/ferritin-blood-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "vitamin-b12",
    name: "Vitamin B12",
    category: "Thyroid, iron and vitamins",
    aliases: [],
    sample: "blood",
    description: "Measures the level of vitamin B12.",
    preparation:
      "Fasting may be required; confirm duration and permitted drinks, and report medicines/supplements.",
    question: "Should I change supplements before the test?",
    answer:
      "Ask your clinician for instructions; do not change them based on the catalogue alone.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/ency/article/003705.htm",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "vitamin-d",
    name: "Vitamin D (25-hydroxy)",
    category: "Thyroid, iron and vitamins",
    aliases: ["25-OH vitamin D", "calcidiol"],
    sample: "blood",
    description: "Measures the commonly assessed form of vitamin D.",
    preparation:
      "No special preparation is usually needed; tell the clinician about medicines, vitamins and supplements.",
    question: "Is this every type of vitamin D test?",
    answer: "No; this entry refers to the 25-hydroxy measurement.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/lab-tests/vitamin-d-test/",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "urinalysis",
    name: "Urinalysis",
    category: "Urine and stool",
    aliases: ["UA", "urine analysis"],
    sample: "urine",
    description:
      "Examines physical, chemical and microscopic features of urine.",
    preparation:
      "Ask which collection method and container are required; report medicines that can affect the sample.",
    question: "Should I collect at home?",
    answer:
      "Obtain the laboratory's collection instructions first; a routine sample is not automatically a 24-hour collection.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/ency/article/003579.htm",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "urine-culture",
    name: "Urine culture",
    category: "Urine and stool",
    aliases: [],
    sample: "urine",
    description:
      "Checks a urine sample for bacterial or other microbial growth.",
    preparation:
      "Use the instructed collection method and supplied kit/container. Tell your clinician about antibiotics; do not stop treatment yourself.",
    question: "Can antibiotics affect a culture?",
    answer: "Yes; tell the clinician/laboratory what you are taking.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/ency/article/003751.htm",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "stool-culture",
    name: "Stool culture",
    category: "Urine and stool",
    aliases: [],
    sample: "stool",
    description:
      "Checks stool for organisms that can cause gastrointestinal illness.",
    preparation:
      "Obtain the correct collection container and instructions; avoid mixing urine, water or toilet paper into the sample.",
    question: "Can I use any container?",
    answer:
      "Follow the laboratory's supplied-container instructions; different stool tests may require different kits.",
    sources: [
      {
        label: "Source",
        url: "https://medlineplus.gov/ency/article/003758.htm",
      },
    ],
    checked: "2026-11-04",
  },
  {
    id: "fit",
    name: "Fecal immunochemical test (FIT)",
    category: "Urine and stool",
    aliases: ["iFOBT", "immunochemical stool blood test"],
    sample: "stool collected with the supplied FIT kit",
    description: "Detects small amounts of human blood in stool.",
    preparation:
      "No special dietary preparation is generally required for FIT; follow the exact kit's collection and return instructions.",
    question: "Do guaiac stool-test food restrictions apply?",
    answer:
      "FIT and guaiac tests are different; follow the instructions for the supplied test, not another method.",
    sources: [
      {
        label: "FIT source",
        url: "https://medlineplus.gov/ency/patientinstructions/000704.htm",
      },
      {
        label: "method distinction",
        url: "https://medlineplus.gov/lab-tests/fecal-occult-blood-test-fobt/",
      },
    ],
    checked: "2026-11-04",
  },
];

export const laboratoryCategories = [
  ...new Set(laboratoryTests.map((test) => test.category)),
];
export function filterLaboratoryTests(query = "", category = "") {
  const search = query.trim().toLocaleLowerCase();
  return laboratoryTests.filter(
    (test) =>
      (!category || test.category === category) &&
      (!search ||
        [test.name, ...test.aliases]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search)),
  );
}

export const preparationNote =
  "Other tests ordered together may change your preparation. Tell your clinician about medicines and supplements; do not change them based on this page.";
export const laboratoryFaqs = [
  [
    "Does every blood test require fasting?",
    "No. Preparation depends on the ordered tests. Check your instructions before changing what you eat or drink.",
  ],
  [
    "Can I drink water if asked to fast?",
    "Plain water is generally allowed for fasting blood tests. Follow any different instructions your clinician gives for your situation or another procedure.",
  ],
  [
    "What if I did not follow the instructions?",
    "Tell the laboratory before collection so they can advise what to do next.",
  ],
  [
    "Can I book a laboratory visit online?",
    "This website does not offer laboratory booking. Contact reception for service details.",
  ],
];
export const preparationSources = [
  {
    label: "Preparing for a lab test",
    url: "https://medlineplus.gov/lab-tests/how-to-prepare-for-a-lab-test/",
  },
  {
    label: "Fasting guidance",
    url: "https://medlineplus.gov/lab-tests/fasting-for-a-blood-test/",
  },
];
export const audiometryEntries = [
  {
    id: "pure-tone",
    name: "Pure-tone audiometry",
    icon: "hearing",
    description:
      "Uses tones at different pitches and volumes to assess hearing sensitivity.",
  },
  {
    id: "speech",
    name: "Speech testing",
    icon: "speech",
    description: "Uses spoken words to assess how speech is heard.",
  },
  {
    id: "tympanometry",
    name: "Tympanometry",
    icon: "ear",
    description:
      "Assesses eardrum movement and middle-ear function. It is not a replacement for measuring hearing thresholds.",
  },
].map((entry) => ({
  ...entry,
  checked: "2026-11-04",
  sources: [
    {
      label: "Hearing tests for adults",
      url: "https://medlineplus.gov/lab-tests/hearing-tests-for-adults/",
    },
  ],
}));
export const audiometryFaqs = [
  [
    "Can I book online?",
    "Audiometry booking is not offered on this website. Contact reception for visit details.",
  ],
  [
    "Do hearing tests need preparation?",
    "Routine hearing tests generally need no special preparation; confirm any instructions for your visit.",
  ],
  [
    "Does this page provide a hearing test?",
    "No; it explains tests performed by a healthcare professional.",
  ],
];
