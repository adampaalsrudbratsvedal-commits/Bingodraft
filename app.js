const PLAYERS = ["Jonathan", "Adam Pus", "Leon", "0lav", "Torjews"];
const STORAGE_KEY = "klosterbingo-2026-state";

const POPUP_TRIGGERS = {
  "Odin til å Knulle": "OUUUFFF, ville ikke valgt den",
  "Anar knuller 07": "En gang til?",
};

function showPopup(message) {
  document.getElementById("popup-message").textContent = message;
  document.getElementById("popup-overlay").classList.remove("hidden");
}

function hidePopup() {
  document.getElementById("popup-overlay").classList.add("hidden");
}

let state = null;
let undoStack = [];
let supabaseClient = null;
let receivingRemoteUpdate = false;

const SYNC_ROW_ID = "klosterbingo2026";

// ---- Live sync (Supabase) ----

function initSync() {
  if (
    typeof SUPABASE_URL === "undefined" ||
    !SUPABASE_URL ||
    SUPABASE_URL.includes("PASTE")
  ) {
    console.warn("Supabase er ikke konfigurert - markering synkes kun lokalt.");
    return;
  }
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  supabaseClient
    .from("bingo_marks")
    .select("marks")
    .eq("id", SYNC_ROW_ID)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        console.warn("Klarte ikke å hente markering fra Supabase", error);
        return;
      }
      if (data && data.marks) {
        receivingRemoteUpdate = true;
        state.marks = data.marks;
        save();
        if (state.phase === "boards") render();
        receivingRemoteUpdate = false;
      }
    });

  supabaseClient
    .channel("bingo-marks-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bingo_marks", filter: `id=eq.${SYNC_ROW_ID}` },
      (payload) => {
        const newMarks = payload.new && payload.new.marks;
        if (!newMarks) return;
        receivingRemoteUpdate = true;
        state.marks = newMarks;
        save();
        if (state.phase === "boards") render();
        receivingRemoteUpdate = false;
      }
    )
    .subscribe();
}

function pushMarks() {
  if (!supabaseClient || receivingRemoteUpdate) return;
  supabaseClient
    .from("bingo_marks")
    .upsert({ id: SYNC_ROW_ID, marks: state.marks, updated_at: new Date().toISOString() })
    .then(({ error }) => {
      if (error) console.warn("Klarte ikke å synke markering", error);
    });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rotateOrder(round) {
  const base = state.baseOrder && state.baseOrder.length ? state.baseOrder : PLAYERS;
  const n = round % base.length;
  return base.slice(n).concat(base.slice(0, n));
}

function freshState() {
  return {
    phase: "start",
    baseOrder: [],
    deck: [],
    round: 0,
    suggestions: [],
    pickOrder: [],
    pickIndex: 0,
    assignments: {},
    placementRound: 0,
    placementPickIndex: 0,
    boards: {},
    marks: {},
  };
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      state = JSON.parse(raw);
      return;
    } catch (e) {
      console.warn("Kunne ikke lese lagret state", e);
    }
  }
  if (typeof SAVED_RESULT !== "undefined") {
    state = JSON.parse(JSON.stringify(SAVED_RESULT));
    save();
    return;
  }
  state = freshState();
}

// ---- Order draw ----

function drawOrder() {
  undoStack = [];
  state = freshState();
  state.baseOrder = shuffle(PLAYERS);
  state.phase = "draw";
  save();
  render();
}

function redrawOrder() {
  state.baseOrder = shuffle(PLAYERS);
  save();
  render();
}

// ---- Draft ----

function startDraft() {
  state.deck = shuffle([...Array(CARDS.length).keys()]);
  state.round = 0;
  PLAYERS.forEach((p) => (state.assignments[p] = []));
  state.phase = "draft";
  startRound();
  save();
  render();
}

function startRound() {
  if (state.deck.length === 0) {
    initPlacement();
    return;
  }
  state.suggestions = state.deck.splice(0, 5);
  state.pickIndex = 0;
  state.pickOrder = rotateOrder(state.round);
}

function pickCard(cardIdx) {
  undoStack.push(snapshot());
  const player = state.pickOrder[state.pickIndex];
  state.assignments[player].push(cardIdx);
  state.suggestions = state.suggestions.filter((c) => c !== cardIdx);
  state.pickIndex++;
  if (state.pickIndex >= 5) {
    state.round++;
    startRound();
  }
  save();
  render();

  const trigger = POPUP_TRIGGERS[CARDS[cardIdx]];
  if (trigger) showPopup(trigger);
}

// ---- Placement ----

function initPlacement() {
  state.phase = "placement";
  state.placementRound = 0;
  state.placementPickIndex = 0;
  state.boards = {};
  state.marks = {};
  PLAYERS.forEach((p) => {
    state.boards[p] = Array.from({ length: 5 }, () => Array(5).fill(null));
    state.marks[p] = Array.from({ length: 5 }, () => Array(5).fill(false));
  });
}

function placeCard(row, col) {
  const order = rotateOrder(state.placementRound);
  const player = order[state.placementPickIndex];
  if (state.boards[player][row][col] !== null) return;
  undoStack.push(snapshot());
  const cardIdx = state.assignments[player][state.placementRound];
  state.boards[player][row][col] = cardIdx;
  state.placementPickIndex++;
  if (state.placementPickIndex >= PLAYERS.length) {
    state.placementRound++;
    state.placementPickIndex = 0;
    if (state.placementRound >= Math.ceil(CARDS.length / PLAYERS.length)) {
      state.phase = "boards";
    }
  }
  save();
  render();
}

// ---- Boards / play ----

function toggleMark(player, row, col) {
  state.marks[player][row][col] = !state.marks[player][row][col];
  save();
  render();
  pushMarks();
}

// ---- Undo ----

function undo() {
  if (undoStack.length === 0) return;
  state = undoStack.pop();
  save();
  render();
}

// ---- Save/load to file ----

function exportToFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "klosterbingo-2026-resultat.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = JSON.parse(reader.result);
      undoStack = [];
      save();
      render();
    } catch (e) {
      alert("Kunne ikke lese filen. Er det en gyldig lagringsfil?");
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm("Sikker på at du vil nullstille hele draften og brettene?")) return;
  undoStack = [];
  localStorage.removeItem(STORAGE_KEY);
  state = freshState();
  render();
}

// ---- Rendering ----

const screens = {
  start: document.getElementById("screen-start"),
  draw: document.getElementById("screen-draw"),
  draft: document.getElementById("screen-draft"),
  placement: document.getElementById("screen-placement"),
  boards: document.getElementById("screen-boards"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

function renderStart() {
  document.getElementById("player-list-preview").textContent = PLAYERS.join(", ");
}

function renderDraw() {
  const list = document.getElementById("draw-order-list");
  list.innerHTML = "";
  state.baseOrder.forEach((player) => {
    const li = document.createElement("li");
    li.textContent = player;
    list.appendChild(li);
  });
}

function renderDraft() {
  document.getElementById("round-label").textContent =
    `Runde ${state.round + 1} / ${Math.ceil(CARDS.length / PLAYERS.length)}`;
  document.getElementById("current-picker").textContent =
    state.pickOrder[state.pickIndex];

  const orderEl = document.getElementById("pick-order");
  orderEl.innerHTML = "";
  state.pickOrder.forEach((player, i) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    if (i === state.pickIndex) pill.classList.add("active");
    if (i < state.pickIndex) pill.classList.add("done");
    pill.textContent = player;
    orderEl.appendChild(pill);
  });

  const grid = document.getElementById("suggestions");
  grid.innerHTML = "";
  state.suggestions.forEach((cardIdx) => {
    const div = document.createElement("div");
    div.className = "suggestion-card";
    div.textContent = CARDS[cardIdx];
    div.addEventListener("click", () => pickCard(cardIdx));
    grid.appendChild(div);
  });
}

function renderPlacement() {
  const order = rotateOrder(state.placementRound);
  const player = order[state.placementPickIndex];
  const totalRounds = Math.ceil(CARDS.length / PLAYERS.length);

  document.getElementById("placement-round-label").textContent =
    `Runde ${state.placementRound + 1} / ${totalRounds}`;
  document.getElementById("placement-current-picker").textContent = player;

  const orderEl = document.getElementById("placement-pick-order");
  orderEl.innerHTML = "";
  order.forEach((p, i) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    if (i === state.placementPickIndex) pill.classList.add("active");
    if (i < state.placementPickIndex) pill.classList.add("done");
    pill.textContent = p;
    orderEl.appendChild(pill);
  });

  const cardIdx = state.assignments[player][state.placementRound];
  document.getElementById("placement-current-card").textContent = CARDS[cardIdx];

  const boardEl = document.getElementById("placement-board");
  boardEl.innerHTML = "";
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const val = state.boards[player][r][c];
      const cell = document.createElement("div");
      cell.className = "cell " + (val === null ? "empty" : "filled");
      if (val === null) {
        cell.addEventListener("click", () => placeCard(r, c));
      } else {
        cell.textContent = CARDS[val];
      }
      boardEl.appendChild(cell);
    }
  }
}

function countMarked(player) {
  return state.marks[player].reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

function countBingos(player) {
  const b = state.marks[player];
  let count = 0;
  for (let r = 0; r < 5; r++) {
    if (b[r].every(Boolean)) count++;
  }
  for (let c = 0; c < 5; c++) {
    if (b.every((row) => row[c])) count++;
  }
  if ([0, 1, 2, 3, 4].every((i) => b[i][i])) count++;
  if ([0, 1, 2, 3, 4].every((i) => b[i][4 - i])) count++;
  return count;
}

function renderBoards() {
  const container = document.getElementById("boards-container");
  container.innerHTML = "";

  const sortedPlayers = PLAYERS.slice().sort((a, b) => countMarked(b) - countMarked(a));

  sortedPlayers.forEach((player) => {
    const block = document.createElement("div");
    block.className = "player-board-block";

    const h3 = document.createElement("h3");
    h3.textContent = player;
    block.appendChild(h3);

    const bingoCount = countBingos(player);
    if (bingoCount > 0) {
      const bingoLabel = document.createElement("div");
      bingoLabel.className = "bingo-label";
      bingoLabel.textContent = Array(bingoCount).fill("BINGO").join(" ");
      block.appendChild(bingoLabel);
    }

    const boardEl = document.createElement("div");
    boardEl.className = "board board-play";
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const cardIdx = state.boards[player][r][c];
        const cell = document.createElement("div");
        cell.className = "cell" + (state.marks[player][r][c] ? " marked" : "");
        cell.textContent = cardIdx === null ? "" : CARDS[cardIdx];
        cell.addEventListener("click", () => toggleMark(player, r, c));
        boardEl.appendChild(cell);
      }
    }
    block.appendChild(boardEl);
    container.appendChild(block);
  });
}

function render() {
  showScreen(state.phase);
  document.getElementById("btn-undo").classList.toggle(
    "hidden",
    undoStack.length === 0 || (state.phase !== "draft" && state.phase !== "placement")
  );

  if (state.phase === "start") renderStart();
  else if (state.phase === "draw") renderDraw();
  else if (state.phase === "draft") renderDraft();
  else if (state.phase === "placement") renderPlacement();
  else if (state.phase === "boards") renderBoards();
}

// ---- Wiring ----

document.getElementById("popup-close").addEventListener("click", hidePopup);
document.getElementById("btn-draw-order").addEventListener("click", drawOrder);
document.getElementById("btn-redraw").addEventListener("click", redrawOrder);
document.getElementById("btn-confirm-draft").addEventListener("click", startDraft);
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-save").addEventListener("click", exportToFile);
document.getElementById("btn-reset").addEventListener("click", resetAll);
document.getElementById("file-load").addEventListener("change", (e) => {
  if (e.target.files[0]) importFromFile(e.target.files[0]);
  e.target.value = "";
});

load();
render();
initSync();
