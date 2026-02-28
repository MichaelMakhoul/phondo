/**
 * US Area Code → State Mapping
 *
 * Maps NPA (Numbering Plan Area) codes to 2-letter US state codes.
 * Used for caller-side recording consent determination.
 * Source: NANPA (North American Numbering Plan Administration)
 *
 * Note: Some area codes span multiple states (rare) — we use the primary state.
 * Non-geographic codes (800, 888, etc.) are excluded (return null).
 */

const AREA_CODE_TO_STATE = {
  // Alabama
  205: "AL", 251: "AL", 256: "AL", 334: "AL", 938: "AL",
  // Alaska
  907: "AK",
  // Arizona
  480: "AZ", 520: "AZ", 602: "AZ", 623: "AZ", 928: "AZ",
  // Arkansas
  479: "AR", 501: "AR", 870: "AR",
  // California
  209: "CA", 213: "CA", 279: "CA", 310: "CA", 323: "CA", 341: "CA",
  350: "CA", 408: "CA", 415: "CA", 424: "CA", 442: "CA", 510: "CA",
  530: "CA", 559: "CA", 562: "CA", 619: "CA", 626: "CA", 628: "CA",
  650: "CA", 657: "CA", 661: "CA", 669: "CA", 707: "CA", 714: "CA",
  747: "CA", 760: "CA", 805: "CA", 818: "CA", 820: "CA", 831: "CA",
  840: "CA", 858: "CA", 909: "CA", 916: "CA", 925: "CA", 949: "CA",
  951: "CA",
  // Colorado
  303: "CO", 719: "CO", 720: "CO", 970: "CO",
  // Connecticut
  203: "CT", 475: "CT", 860: "CT", 959: "CT",
  // Delaware
  302: "DE",
  // District of Columbia
  202: "DC",
  // Florida
  239: "FL", 305: "FL", 321: "FL", 352: "FL", 386: "FL", 407: "FL",
  561: "FL", 727: "FL", 754: "FL", 772: "FL", 786: "FL", 813: "FL",
  850: "FL", 863: "FL", 904: "FL", 941: "FL", 954: "FL",
  // Georgia
  229: "GA", 404: "GA", 470: "GA", 478: "GA", 678: "GA", 706: "GA",
  762: "GA", 770: "GA", 912: "GA", 943: "GA",
  // Hawaii
  808: "HI",
  // Idaho
  208: "ID", 986: "ID",
  // Illinois
  217: "IL", 224: "IL", 309: "IL", 312: "IL", 331: "IL", 618: "IL",
  630: "IL", 708: "IL", 773: "IL", 779: "IL", 815: "IL", 847: "IL",
  872: "IL",
  // Indiana
  219: "IN", 260: "IN", 317: "IN", 463: "IN", 574: "IN", 765: "IN",
  812: "IN", 930: "IN",
  // Iowa
  319: "IA", 515: "IA", 563: "IA", 641: "IA", 712: "IA",
  // Kansas
  316: "KS", 620: "KS", 785: "KS", 913: "KS",
  // Kentucky
  270: "KY", 364: "KY", 502: "KY", 606: "KY", 859: "KY",
  // Louisiana
  225: "LA", 318: "LA", 337: "LA", 504: "LA", 985: "LA",
  // Maine
  207: "ME",
  // Maryland
  240: "MD", 301: "MD", 410: "MD", 443: "MD", 667: "MD",
  // Massachusetts
  339: "MA", 351: "MA", 413: "MA", 508: "MA", 617: "MA", 774: "MA",
  781: "MA", 857: "MA", 978: "MA",
  // Michigan
  231: "MI", 248: "MI", 269: "MI", 313: "MI", 517: "MI", 586: "MI",
  616: "MI", 734: "MI", 810: "MI", 906: "MI", 947: "MI", 989: "MI",
  // Minnesota
  218: "MN", 320: "MN", 507: "MN", 612: "MN", 651: "MN", 763: "MN",
  952: "MN",
  // Mississippi
  228: "MS", 601: "MS", 662: "MS", 769: "MS",
  // Missouri
  314: "MO", 417: "MO", 573: "MO", 636: "MO", 660: "MO", 816: "MO",
  // Montana
  406: "MT",
  // Nebraska
  308: "NE", 402: "NE", 531: "NE",
  // Nevada
  702: "NV", 725: "NV", 775: "NV",
  // New Hampshire
  603: "NH",
  // New Jersey
  201: "NJ", 551: "NJ", 609: "NJ", 640: "NJ", 732: "NJ", 848: "NJ",
  856: "NJ", 862: "NJ", 908: "NJ", 973: "NJ",
  // New Mexico
  505: "NM", 575: "NM",
  // New York
  212: "NY", 315: "NY", 332: "NY", 347: "NY", 516: "NY", 518: "NY",
  585: "NY", 607: "NY", 631: "NY", 646: "NY", 680: "NY", 716: "NY",
  718: "NY", 838: "NY", 845: "NY", 914: "NY", 917: "NY", 929: "NY",
  934: "NY",
  // North Carolina
  252: "NC", 336: "NC", 704: "NC", 743: "NC", 828: "NC", 910: "NC",
  919: "NC", 980: "NC", 984: "NC",
  // North Dakota
  701: "ND",
  // Ohio
  216: "OH", 220: "OH", 234: "OH", 283: "OH", 326: "OH", 330: "OH",
  380: "OH", 419: "OH", 440: "OH", 513: "OH", 567: "OH", 614: "OH",
  740: "OH", 937: "OH",
  // Oklahoma
  405: "OK", 539: "OK", 572: "OK", 580: "OK", 918: "OK",
  // Oregon
  458: "OR", 503: "OR", 541: "OR", 971: "OR",
  // Pennsylvania
  215: "PA", 223: "PA", 267: "PA", 272: "PA", 412: "PA", 445: "PA",
  484: "PA", 570: "PA", 582: "PA", 610: "PA", 717: "PA", 724: "PA",
  814: "PA", 835: "PA", 878: "PA",
  // Rhode Island
  401: "RI",
  // South Carolina
  803: "SC", 839: "SC", 843: "SC", 854: "SC", 864: "SC",
  // South Dakota
  605: "SD",
  // Tennessee
  423: "TN", 615: "TN", 629: "TN", 731: "TN", 865: "TN", 901: "TN",
  931: "TN",
  // Texas
  210: "TX", 214: "TX", 254: "TX", 281: "TX", 325: "TX", 346: "TX",
  361: "TX", 409: "TX", 430: "TX", 432: "TX", 469: "TX", 512: "TX",
  682: "TX", 713: "TX", 726: "TX", 737: "TX", 806: "TX", 817: "TX",
  830: "TX", 832: "TX", 903: "TX", 915: "TX", 936: "TX", 940: "TX",
  956: "TX", 972: "TX", 979: "TX",
  // Utah
  385: "UT", 435: "UT", 801: "UT",
  // Vermont
  802: "VT",
  // Virginia
  276: "VA", 434: "VA", 540: "VA", 571: "VA", 703: "VA", 757: "VA",
  804: "VA", 826: "VA", 948: "VA",
  // Washington
  206: "WA", 253: "WA", 360: "WA", 425: "WA", 509: "WA", 564: "WA",
  // West Virginia
  304: "WV", 681: "WV",
  // Wisconsin
  262: "WI", 274: "WI", 414: "WI", 534: "WI", 608: "WI", 715: "WI",
  920: "WI",
  // Wyoming
  307: "WY",
};

/**
 * Extract the US state from a phone number based on area code.
 *
 * @param {string|null|undefined} phone - Phone number in E.164 (+1NPAXXXXXXX),
 *   10-digit (NPAXXXXXXX), or 11-digit (1NPAXXXXXXX) format
 * @returns {string|null} 2-letter state code or null if not a US number / unknown area code
 */
function getStateFromPhone(phone) {
  if (!phone || typeof phone !== "string") return null;

  // Strip non-digits
  const digits = phone.replace(/\D/g, "");

  let areaCode;
  if (digits.length === 10) {
    areaCode = parseInt(digits.substring(0, 3), 10);
  } else if (digits.length === 11 && digits[0] === "1") {
    areaCode = parseInt(digits.substring(1, 4), 10);
  } else {
    return null;
  }

  return AREA_CODE_TO_STATE[areaCode] || null;
}

module.exports = {
  getStateFromPhone,
  AREA_CODE_TO_STATE,
};
