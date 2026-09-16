"use strict";

const MAX_COORDINATE = 1000000;
const MAX_SIZE = 100000;

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validAreaRect(rect) {
  return exactKeys(rect, ["x", "y", "width", "height"])
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
    && Math.abs(rect.x) <= MAX_COORDINATE && Math.abs(rect.y) <= MAX_COORDINATE
    && rect.width > 0 && rect.width <= MAX_SIZE
    && rect.height > 0 && rect.height <= MAX_SIZE;
}

function validParticipant(participant) {
  return exactKeys(participant, ["petId", "width", "height"])
    && typeof participant.petId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(participant.petId)
    && !participant.petId.includes("..")
    && Number.isSafeInteger(participant.width) && participant.width > 0 && participant.width <= MAX_SIZE
    && Number.isSafeInteger(participant.height) && participant.height > 0 && participant.height <= MAX_SIZE;
}

function fail(reason) {
  return { ok: false, reason };
}

function planGatheringLayout(areaRect, participants, gap = 12) {
  if (!validAreaRect(areaRect)) return fail("invalid_area");
  if (!Number.isSafeInteger(gap) || gap < 0 || gap > MAX_SIZE) return fail("invalid_gap");
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > 8) {
    return fail("invalid_participants");
  }

  const petIds = new Set();
  for (const participant of participants) {
    if (!validParticipant(participant) || petIds.has(participant.petId)) {
      return fail("invalid_participants");
    }
    petIds.add(participant.petId);
  }

  const cellWidth = Math.max(...participants.map((participant) => participant.width));
  const cellHeight = Math.max(...participants.map((participant) => participant.height));
  const columns = Math.min(
    participants.length,
    Math.floor((areaRect.width + gap) / (cellWidth + gap))
  );
  const maxRows = Math.floor((areaRect.height + gap) / (cellHeight + gap));
  if (columns < 1 || maxRows < 1 || participants.length > columns * maxRows) {
    return fail("insufficient_space");
  }

  const rows = Math.ceil(participants.length / columns);
  const gridHeight = rows * cellHeight + (rows - 1) * gap;
  const gridY = areaRect.y + Math.floor((areaRect.height - gridHeight) / 2);
  const targets = participants.map((participant, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const membersInRow = Math.min(columns, participants.length - row * columns);
    const rowWidth = membersInRow * cellWidth + (membersInRow - 1) * gap;
    const rowX = areaRect.x + Math.floor((areaRect.width - rowWidth) / 2);
    return {
      petId: participant.petId,
      x: rowX + column * (cellWidth + gap) + Math.floor((cellWidth - participant.width) / 2),
      y: gridY + row * (cellHeight + gap) + Math.floor((cellHeight - participant.height) / 2),
    };
  });

  return { ok: true, targets };
}

module.exports = { planGatheringLayout };
