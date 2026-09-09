"use strict";

const runtime = require("./runtime");
const clawd = require("./adapters/clawd");
const contract = require("./contract");

// Explicit named factories distinguish the neutral core from its adapter.
module.exports = { ...runtime, ...contract, ...clawd };
