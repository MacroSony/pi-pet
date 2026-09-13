"use strict";

const runtime = require("./runtime");
const clawd = require("./adapters/clawd");
const contract = require("./contract");
const interaction = require("./interaction");
const teamStore = require("./team-store");
const teamBoardStore = require("./team-board-store");

// Explicit named factories distinguish the neutral core from its adapter.
module.exports = { ...runtime, ...contract, ...clawd, ...interaction, ...teamStore, ...teamBoardStore };
