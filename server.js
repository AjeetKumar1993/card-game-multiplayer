
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const ROUND_RESULT_DISPLAY_MS = 10 * 1000;

function generateDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let v = 2; v <= 14; v++) {
      deck.push({ suit: s, value: v });
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function shuffleDeckPass(deck) {
  const shuffled = deck.map(card => ({ ...card }));
  const swapCount = 8 + Math.floor(Math.random() * 9);

  for (let i = 0; i < swapCount; i++) {
    const first = Math.floor(Math.random() * shuffled.length);
    let second = Math.floor(Math.random() * (shuffled.length - 1));
    if (second >= first) second++;
    [shuffled[first], shuffled[second]] = [
      shuffled[second],
      shuffled[first]
    ];
  }

  return shuffled;
}

function shuffleDealSeats(deck) {
  const seats = [0, 1, 2, 3];
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }

  const shuffled = [];
  seats.forEach(seat => {
    shuffled.push(...deck.slice(seat * 5, seat * 5 + 5));
  });
  seats.forEach(seat => {
    const start = 20 + seat * 8;
    shuffled.push(...deck.slice(start, start + 8));
  });

  return shuffled;
}

function isValidDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== 52) return false;
  const cards = new Set();

  return deck.every(card => {
    if (
      !card ||
      !Number.isInteger(card.suit) ||
      card.suit < 0 ||
      card.suit > 3 ||
      !Number.isInteger(card.value) ||
      card.value < 2 ||
      card.value > 14
    ) return false;

    const key = `${card.suit}:${card.value}`;
    if (cards.has(key)) return false;
    cards.add(key);
    return true;
  });
}

function getOpeningDealScore(deck) {
  const handScores = [];

  for (let player = 0; player < 4; player++) {
    const hand = deck.slice(player * 5, player * 5 + 5);
    let highCardPoints = 0;
    const suitCounts = [0, 0, 0, 0];

    hand.forEach(card => {
      suitCounts[card.suit]++;
      highCardPoints += card.value === 14
        ? 4
        : card.value === 13
          ? 3
          : card.value === 12
            ? 2
            : card.value === 11
              ? 1
              : 0;
    });

    const longestSuit = Math.max(...suitCounts);
    const shapeBonus = longestSuit >= 3 ? (longestSuit - 2) * 1.25 : 0;
    handScores.push(highCardPoints + shapeBonus);
  }

  const totalQuality = handScores.reduce((total, score) => total + score, 0);
  const averageQuality = totalQuality / handScores.length;
  const variance = handScores.reduce(
    (total, score) => total + (score - averageQuality) ** 2,
    0
  ) / handScores.length;

  return totalQuality * 2 +
    Math.min(...handScores) * 2 -
    variance * 0.75;
}

function generateDeckForRoom(room) {
  if (
    room.gameNumber === 1 ||
    !isValidDeck(room.previousGameDeck)
  ) {
    return generateDeck();
  }

  const candidates = [];
  for (let i = 0; i < 12; i++) {
    let candidate = room.previousGameDeck.map(card => ({ ...card }));
    const shufflePasses = 1 + Math.floor(Math.random() * 2);

    for (let pass = 0; pass < shufflePasses; pass++) {
      candidate = shuffleDeckPass(candidate);
    }
    candidate = shuffleDealSeats(candidate);

    if (candidate.every((card, index) =>
      card.suit === room.previousGameDeck[index].suit &&
      card.value === room.previousGameDeck[index].value
    )) {
      const first = Math.floor(Math.random() * candidate.length);
      let second = Math.floor(Math.random() * (candidate.length - 1));
      if (second >= first) second++;
      [candidate[first], candidate[second]] = [
        candidate[second],
        candidate[first]
      ];
    }

    candidates.push({
      deck: candidate,
      score: getOpeningDealScore(candidate)
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const shortlist = candidates.slice(0, 4);
  return shortlist[Math.floor(Math.random() * shortlist.length)].deck;
}

function getValidMoves(hand, trick) {
  if (!trick || trick.length === 0) return [...hand];

  const ledSuit = trick[0].card.suit;
  const sameSuit = hand.filter(c => c.suit === ledSuit);

  return sameSuit.length > 0 ? sameSuit : [...hand];
}

function resolveTrickWinner(trick, trumpSuit) {
  const ledSuit = trick[0].card.suit;
  let winningPlay = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const play = trick[i];

    if (play.card.suit === trumpSuit) {
      if (
        winningPlay.card.suit !== trumpSuit ||
        play.card.value > winningPlay.card.value
      ) {
        winningPlay = play;
      }
    } else if (
      play.card.suit === ledSuit &&
      winningPlay.card.suit === ledSuit
    ) {
      if (play.card.value > winningPlay.card.value) {
        winningPlay = play;
      }
    }
  }

  return winningPlay.playerIndex;
}

io.on('connection', (socket) => {
  socket.on('joinRoom', payload => {
    if (!payload || typeof payload !== 'object') return;
    const { roomCode, playerName } = payload;
    const code = (typeof roomCode === 'string' && roomCode.trim()
      ? roomCode.trim()
      : 'CHHAPUR').toUpperCase();

    if (!rooms[code]) {
      rooms[code] = {
        roomCode: code,
        players: [],
        previousGameDeck: [],
        hostId: null,
        selectedPartnerId: null,
        gameNumber: 1,
        handNumber: 1,
        gameState: 'LOBBY',
        gameScore: 0,
        teamGameWins: [0, 0],
        dealerIndex: 0,
        scoreHistory: [],
        currentTrick: [],
        pendingTricks: [],
        teamTricksWon: [0, 0],
        opposingConsecutiveTricks: 0,
        handResultApplied: false,
        roundEndReason: null,
        roundResultTimer: null,
        roundResultDeadlineAt: null,
        trickNo: 1,
        pot: 0,
        lastWinner: null,
        leadIndex: 0,
        turnIndex: 0,
        highestBid: 8,
        bidderIndex: -1,
        auctionTurnIndex: 0,
        auctionTurnCount: 0,
        trumpSuit: null,
        fullHouse: null,
        trophyWinner: null,
        deck: [],
        roomMessage: null,
        roundMessage: null,
        reconnectTimers: new Map()
      };
    }

    const room = rooms[code];
    const reconnectToken = typeof payload?.reconnectToken === 'string'
      ? payload.reconnectToken
      : '';
    const returningPlayer = reconnectToken
      ? room.players.find(player => player.reconnectToken === reconnectToken)
      : null;

    if (returningPlayer) {
      const oldId = returningPlayer.id;
      const reconnectTimer = room.reconnectTimers.get(reconnectToken);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      room.reconnectTimers.delete(reconnectToken);
      if (room.hostId === oldId) room.hostId = socket.id;
      if (room.selectedPartnerId === oldId) {
        room.selectedPartnerId = socket.id;
      }
      returningPlayer.id = socket.id;
      returningPlayer.connected = true;
      if (oldId !== socket.id) {
        io.sockets.sockets.get(oldId)?.disconnect(true);
      }
      socket.join(code);
      room.roomMessage = `${returningPlayer.name} वापस जुड़ गए।`;
      socket.emit('joinResult', { ok: true, reconnectToken });
    } else if (room.players.length < 4) {
      const seatIndex = room.players.length;
      const teamId = (seatIndex === 0 || seatIndex === 2) ? 1 : 2;

      room.players.push({
        id: socket.id,
        name: playerName || `Player ${seatIndex + 1}`,
        reconnectToken: crypto.randomBytes(32).toString('hex'),
        connected: true,
        seatIndex,
        teamId,
        hand: [],
        tricksWon: 0,
        hasPassed: false,
        currentBid: 0
      });

      if (!room.hostId) {
        room.hostId = socket.id;
      }
      socket.join(code);
      const joinedPlayer = room.players[room.players.length - 1];
      socket.emit('joinResult', {
        ok: true,
        reconnectToken: joinedPlayer.reconnectToken
      });
    } else {
      socket.emit('joinResult', {
        ok: false,
        message: 'यह रूम भर चुका है।'
      });
    }

    broadcastRoomState(room);
  });

  socket.on('chat:send', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (
      !payload ||
      typeof payload.roomCode !== 'string' ||
      typeof payload.text !== 'string'
    ) {
      reply({ ok: false, message: 'संदेश भेजा नहीं जा सका।' });
      return;
    }

    const room = rooms[payload.roomCode];
    const player = room &&
      room.players.find(candidate => candidate.id === socket.id);
    const text = payload.text.trim();
    if (!player || !text || text.length > 500) {
      reply({
        ok: false,
        message: !player
          ? 'पहले इस रूम में शामिल हों।'
          : 'संदेश खाली है या 500 अक्षरों से बड़ा है।'
      });
      return;
    }

    io.to(payload.roomCode).emit('chat:message', {
      playerName: player.name,
      text,
      sentAt: Date.now()
    });
    reply({ ok: true });
  });

  socket.on('selectTeammate', ({ roomCode, teammateId }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'LOBBY' ||
      room.players.length !== 4 ||
      typeof teammateId !== 'string' ||
      teammateId === socket.id
    ) return;

    const teammate = room.players.find(player => player.id === teammateId);
    const dealer = room.players[room.dealerIndex];
    if (!teammate || !dealer || dealer.id !== socket.id) return;

    room.selectedPartnerId = teammateId;
    room.players.forEach(player => {
      player.teamId =
        player.id === dealer.id || player.id === teammateId ? 1 : 2;
    });
    broadcastRoomState(room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'LOBBY' ||
      room.players[room.dealerIndex]?.id !== socket.id ||
      room.players.length !== 4 ||
      !room.selectedPartnerId ||
      !room.players.some(player => player.id === room.selectedPartnerId)
    ) return;

    room.roomMessage = null;
    startNewHand(room);
    broadcastRoomState(room);
  });

  socket.on('placeBid', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!payload || typeof payload.roomCode !== 'string') {
      reply({ ok: false, message: 'रूम की जानकारी नहीं मिली।' });
      return;
    }

    const { roomCode, bid, passed } = payload;
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'AUCTION' ||
      room.auctionTurnCount >= 4
    ) {
      reply({ ok: false, message: 'अभी बोली नहीं लगाई जा सकती।' });
      return;
    }

    const currentPlayer = room.players[room.auctionTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      reply({ ok: false, message: 'अभी आपकी बोली की बारी नहीं है।' });
      broadcastRoomState(room);
      return;
    }

    if (passed && room.auctionTurnCount === 0) {
      room.highestBid = 8;
      room.bidderIndex = room.auctionTurnIndex;
      currentPlayer.currentBid = 8;
    } else if (passed) {
      currentPlayer.hasPassed = true;
    } else if (
      Number.isInteger(bid) &&
      (room.bidderIndex === -1
        ? bid >= 8
        : bid > room.highestBid) &&
      bid <= 13
    ) {
      room.highestBid = bid;
      room.bidderIndex = room.auctionTurnIndex;
      currentPlayer.currentBid = bid;
    } else {
      reply({
        ok: false,
        message: `बोली ${room.bidderIndex === -1 ? 8 : room.highestBid + 1} से 13 के बीच होनी चाहिए।`
      });
      return;
    }

    room.auctionTurnCount++;

    if (room.bidderIndex === -1 && room.auctionTurnCount === 4) {
      room.bidderIndex = room.dealerIndex;
      room.highestBid = 8;
      room.players[room.bidderIndex].currentBid = 8;
      room.gameState = 'TRUMP_SELECT';
    } else if (room.auctionTurnCount === 4) {
      room.gameState = 'TRUMP_SELECT';
    } else {
      room.auctionTurnIndex = (room.auctionTurnIndex + 3) % 4;
    }

    broadcastRoomState(room);
    reply({ ok: true });
  });

  socket.on('callFullHouse', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.fullHouse || room.players.length !== 4) return;

    const caller = room.players.find(player => player.id === socket.id);
    if (!caller) return;

    if (
      room.gameState === 'AUCTION' &&
      room.auctionTurnCount < 4 &&
      room.players[room.auctionTurnIndex]?.id === socket.id
    ) {
      room.fullHouse = {
        callerSeat: caller.seatIndex,
        partnerSeat: getPartnerSeat(room, caller.seatIndex),
        phase: 'INITIAL',
        status: 'ACTIVE'
      };
      room.bidderIndex = caller.seatIndex;
      room.gameState = 'TRUMP_SELECT';
    } else if (
      room.gameState === 'PLAYING' &&
      room.trickNo === 1 &&
      room.currentTrick.length === 0 &&
      room.pendingTricks.length === 0
    ) {
      room.fullHouse = {
        callerSeat: caller.seatIndex,
        partnerSeat: getPartnerSeat(room, caller.seatIndex),
        phase: 'LATE',
        status: 'ACTIVE'
      };
      room.turnIndex = caller.seatIndex;
      room.leadIndex = caller.seatIndex;
    } else {
      return;
    }

    broadcastRoomState(room);
  });

  socket.on('selectTrump', ({ roomCode, suitIndex }) => {
    const room = rooms[roomCode];

    if (!room || room.gameState !== 'TRUMP_SELECT') return;
    if (!Number.isInteger(suitIndex) || suitIndex < 0 || suitIndex > 3) return;

    const winningBidder = room.players[room.bidderIndex];
    if (!winningBidder || winningBidder.id !== socket.id) return;

    room.trumpSuit = suitIndex;
    distributeRemainingCards(room);

    room.gameState = 'PLAYING';

    // सबसे ऊँची बोली लगाने वाला खिलाड़ी पहली चाल चलेगा।
    const firstPlayer = room.fullHouse &&
      room.fullHouse.phase === 'INITIAL'
      ? room.fullHouse.callerSeat
      : room.bidderIndex;
    room.turnIndex = firstPlayer;
    room.leadIndex = firstPlayer;

    room.currentTrick = [];
    room.pendingTricks = [];

    broadcastRoomState(room);
  });

  socket.on('playCard', ({ roomCode, card }) => {
    const room = rooms[roomCode];

    if (
      !room ||
      room.gameState !== 'PLAYING' ||
      room.currentTrick.length >= 4
    ) return;
    if (
      !card ||
      !Number.isInteger(card.suit) ||
      !Number.isInteger(card.value)
    ) return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    const validMoves = getValidMoves(currentPlayer.hand, room.currentTrick);

    const isValid = validMoves.some(
      c => c.suit === card.suit && c.value === card.value
    );

    if (!isValid) return;

    const cardIdx = currentPlayer.hand.findIndex(
      c => c.suit === card.suit && c.value === card.value
    );

    if (cardIdx === -1) return;

    currentPlayer.hand.splice(cardIdx, 1);

    room.currentTrick.push({
      playerIndex: currentPlayer.seatIndex,
      card: { ...card }
    });

    if (room.currentTrick.length < 4) {
      room.turnIndex = (room.turnIndex + 3) % 4;
      broadcastRoomState(room);
    } else {
      // चारों कार्ड थोड़ी देर दिखाएँ, फिर चाल का विजेता तय करें।
      broadcastRoomState(room);

      setTimeout(() => {
        const latestRoom = rooms[roomCode];

        if (
          latestRoom &&
          latestRoom.gameState === 'PLAYING' &&
          latestRoom.currentTrick.length === 4
        ) {
          resolveTrick(latestRoom);
        }
      }, 1200);
    }
  });

  socket.on('nextHand', ({ roomCode }) => {
    const room = rooms[roomCode];

    if (
      room &&
      room.gameState === 'HAND_OVER' &&
      (!room.roundResultDeadlineAt ||
        room.roundResultDeadlineAt <= Date.now())
    ) {
      startNewHand(room);
      broadcastRoomState(room);
    }
  });

  socket.on('restartRoom', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      !room.players.some(player => player.id === socket.id)
    ) return;

    room.reconnectTimers.forEach(timer => clearTimeout(timer));
    room.reconnectTimers.clear();
    room.players = [];
    room.hostId = null;
    room.selectedPartnerId = null;
    room.gameNumber = 1;
    room.handNumber = 1;
    room.gameState = 'LOBBY';
    room.gameScore = 0;
    room.teamGameWins = [0, 0];
    room.dealerIndex = 0;
    room.scoreHistory = [];
    room.currentTrick = [];
    room.pendingTricks = [];
    room.teamTricksWon = [0, 0];
    room.opposingConsecutiveTricks = 0;
    room.handResultApplied = false;
    clearRoundResultTimer(room);
    room.roundEndReason = null;
    room.trickNo = 1;
    room.pot = 0;
    room.lastWinner = null;
    room.leadIndex = 0;
    room.turnIndex = 0;
    room.highestBid = 8;
    room.bidderIndex = -1;
    room.auctionTurnIndex = 0;
    room.auctionTurnCount = 0;
    room.trumpSuit = null;
    room.fullHouse = null;
    room.trophyWinner = null;
    room.deck = [];
    room.previousGameDeck = [];
    room.roundMessage = null;
    room.roomMessage = 'नया गेम शुरू करने के लिए खिलाड़ी फिर से जुड़ें।';
    io.to(roomCode).emit('roomRestarted');
    broadcastRoomState(room);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);

      if (pIdx !== -1) {
        const departedPlayer = room.players[pIdx];
        departedPlayer.connected = false;
        const reconnectToken = departedPlayer.reconnectToken;
        const timer = setTimeout(() => {
          room.reconnectTimers.delete(reconnectToken);
          if (
            room.players.includes(departedPlayer) &&
            !departedPlayer.connected
          ) {
            removePlayerFromRoom(room, departedPlayer);
          }
        }, RECONNECT_GRACE_MS);
        room.reconnectTimers.set(reconnectToken, timer);
        broadcastRoomState(room);
      }
    }
  });
});

function removePlayerFromRoom(room, departedPlayer) {
  const reconnectTimer = room.reconnectTimers.get(departedPlayer.reconnectToken);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  room.reconnectTimers.delete(departedPlayer.reconnectToken);
  room.players.splice(room.players.indexOf(departedPlayer), 1);
  room.hostId = room.players.length ? room.players[0].id : null;
  room.selectedPartnerId = null;

  room.players.forEach((player, index) => {
    player.seatIndex = index;
    player.teamId = (index === 0 || index === 2) ? 1 : 2;
    player.hand = [];
    player.tricksWon = 0;
    player.hasPassed = false;
    player.currentBid = 0;
  });

  room.gameNumber = 1;
  room.handNumber = 1;
  room.gameState = 'LOBBY';
  room.gameScore = 0;
  room.teamGameWins = [0, 0];
  room.previousGameDeck = [];
  room.dealerIndex = 0;
  room.scoreHistory = [];
  room.currentTrick = [];
  room.pendingTricks = [];
  room.teamTricksWon = [0, 0];
  room.opposingConsecutiveTricks = 0;
  room.handResultApplied = false;
  clearRoundResultTimer(room);
  room.roundEndReason = null;
  room.trickNo = 1;
  room.pot = 0;
  room.lastWinner = null;
  room.leadIndex = 0;
  room.turnIndex = 0;
  room.highestBid = 8;
  room.bidderIndex = -1;
  room.auctionTurnIndex = 0;
  room.auctionTurnCount = 0;
  room.trumpSuit = null;
  room.fullHouse = null;
  room.trophyWinner = null;
  room.deck = [];
  room.roundMessage = null;
  room.roomMessage = `${departedPlayer.name} से कनेक्शन टूट गया। 5 मिनट में वापस जुड़ें; उसके बाद खेल रीसेट होगा।`;
  broadcastRoomState(room);
}

function startNewHand(room) {
  clearRoundResultTimer(room);
  room.gameState = 'AUCTION';
  room.deck = generateDeckForRoom(room);
  room.currentTrick = [];
  room.pendingTricks = [];
  room.teamTricksWon = [0, 0];
  room.opposingConsecutiveTricks = 0;
  room.handResultApplied = false;
  room.roundEndReason = null;
  room.trickNo = 1;
  room.roundMessage = null;
  room.pot = 0;
  room.lastWinner = null;
  room.highestBid = 8;
  room.bidderIndex = -1;
  room.auctionTurnCount = 0;
  room.trumpSuit = null;
  room.fullHouse = null;

  room.auctionTurnIndex = room.dealerIndex;
  room.turnIndex = room.dealerIndex;

  room.players.forEach((p, idx) => {
    p.hand = room.deck
      .slice(idx * 5, (idx + 1) * 5)
      .sort((a, b) => a.suit - b.suit || a.value - b.value);

    p.tricksWon = 0;
    p.hasPassed = false;
    p.currentBid = 0;
  });
}

function clearRoundResultTimer(room) {
  if (room.roundResultTimer) {
    clearTimeout(room.roundResultTimer);
  }
  room.roundResultTimer = null;
  room.roundResultDeadlineAt = null;
}

function scheduleRoundResultTransition(room) {
  if (
    !room.handResultApplied ||
    (room.gameState !== 'HAND_OVER' && room.gameState !== 'MATCH_OVER') ||
    room.roundResultTimer
  ) return;

  const deadlineAt = Date.now() + ROUND_RESULT_DISPLAY_MS;
  room.roundResultDeadlineAt = deadlineAt;
  room.roundResultTimer = setTimeout(() => {
    room.roundResultTimer = null;
    if (
      rooms[room.roomCode] !== room ||
      !room.handResultApplied ||
      room.roundResultDeadlineAt !== deadlineAt
    ) return;

    room.roundResultDeadlineAt = null;
    if (room.gameState === 'HAND_OVER') {
      startNewHand(room);
    } else if (room.gameState === 'MATCH_OVER') {
      room.roundMessage = null;
    } else {
      return;
    }
    broadcastRoomState(room);
  }, ROUND_RESULT_DISPLAY_MS);
}

function getPartnerSeat(room, seatIndex) {
  const player = room.players[seatIndex];
  const partner = room.players.find(
    candidate => candidate.teamId === player.teamId &&
      candidate.seatIndex !== seatIndex
  );
  return partner ? partner.seatIndex : (seatIndex + 2) % 4;
}

function distributeRemainingCards(room) {
  const remainingDeck = room.deck.slice(20);

  room.players.forEach((p, idx) => {
    const extraCards = remainingDeck.slice(idx * 8, (idx + 1) * 8);

    p.hand = [...p.hand, ...extraCards].sort(
      (a, b) => a.suit - b.suit || a.value - b.value
    );
  });
}

function resolveTrick(room) {
  if (!room.currentTrick || room.currentTrick.length !== 4) return;

  const winnerSeat = resolveTrickWinner(
    room.currentTrick,
    room.trumpSuit
  );

  const winner = room.players[winnerSeat];
  if (!winner) return;
  room.teamTricksWon[winner.teamId - 1]++;
  const protectedTeamId = room.fullHouse
    ? room.players[room.fullHouse.callerSeat]?.teamId
    : room.players[room.bidderIndex]?.teamId;
  if (protectedTeamId) {
    room.opposingConsecutiveTricks = winner.teamId === protectedTeamId
      ? 0
      : room.opposingConsecutiveTricks + 1;
  }

  const completedTrick = room.currentTrick.map(play => ({
    playerIndex: play.playerIndex,
    card: { ...play.card }
  }));
  room.pendingTricks.push({
    trickNo: room.trickNo,
    winnerSeat,
    plays: completedTrick
  });

  room.pot++;

  if (room.lastWinner === winnerSeat) {
    winner.tricksWon += room.pot;
    room.pot = 0;
    room.lastWinner = null;
    room.pendingTricks = [];
  } else {
    room.lastWinner = winnerSeat;
  }

  if (room.trickNo === 13 && room.pot > 0) {
    winner.tricksWon += room.pot;
    room.pot = 0;
    room.lastWinner = null;
    room.pendingTricks = [];
  }

  room.currentTrick = [];
  room.turnIndex = winnerSeat;
  room.leadIndex = winnerSeat;

  if (room.fullHouse && room.opposingConsecutiveTricks >= 2) {
    room.roundEndReason = 'TWO_CONSECUTIVE_OPPOSING_TRICKS';
    resolveFullHouse(room);
    if (room.fullHouse.phase === 'INITIAL') {
      finishInitialFullHouse(room);
    } else {
      evaluateSharedScoreRules(room);
    }
    broadcastRoomState(room);
    return;
  }

  if (!room.fullHouse) {
    const bidder = room.players[room.bidderIndex];
    if (bidder && Number.isInteger(room.highestBid)) {
      const defeatThreshold = Math.max(2, 14 - room.highestBid);
      const opposingTeamTricks = room.teamTricksWon[2 - bidder.teamId];
      if (
        room.opposingConsecutiveTricks >= 2 &&
        opposingTeamTricks >= defeatThreshold
      ) {
        room.roundEndReason = 'TWO_CONSECUTIVE_OPPOSING_TRICKS';
        evaluateSharedScoreRules(room);
        broadcastRoomState(room);
        return;
      }
    }
  }

  if (room.trickNo < 13) {
    room.trickNo++;
  } else {
    if (!room.fullHouse && room.highestBid === 10) {
      const bidder = room.players[room.bidderIndex];
      if (bidder && room.teamTricksWon[bidder.teamId - 1] === 13) {
        room.fullHouse = {
          callerSeat: room.bidderIndex,
          partnerSeat: getPartnerSeat(room, room.bidderIndex),
          phase: 'LATE',
          status: 'ACTIVE'
        };
      }
    }

    if (room.fullHouse) {
      resolveFullHouse(room);
    }

    if (room.fullHouse && room.fullHouse.phase === 'INITIAL') {
      finishInitialFullHouse(room);
    } else {
      evaluateSharedScoreRules(room);
    }
  }

  broadcastRoomState(room);
}

function resolveFullHouse(room) {
  const fullHouse = room.fullHouse;
  const caller = room.players[fullHouse.callerSeat];
  if (!caller) return;

  const successful = room.teamTricksWon[caller.teamId - 1] === 13;
  fullHouse.status = successful ? 'WON' : 'LOST';
  fullHouse.result = successful ? 'SUCCESS' : 'FAILED';
  fullHouse.bajiTeam = successful ? caller.teamId : 3 - caller.teamId;
  if (successful) {
    room.roundMessage =
      'Full House सफल रहा! कॉल करने वाली टीम ने सभी 13 चालें और 1 बाजी जीती।';
  } else {
    room.roundMessage =
      'Full House टूट गया! विरोधी टीम ने लगातार 2 चालें जीतकर 1 बाजी जीती।';
  }
}

function finishInitialFullHouse(room) {
  if (room.handResultApplied) return;
  const fullHouse = room.fullHouse;
  const caller = room.players[fullHouse.callerSeat];
  if (!caller || !fullHouse.bajiTeam) {
    room.handResultApplied = true;
    room.gameState = 'HAND_OVER';
    return;
  }

  room.handResultApplied = true;
  room.teamGameWins[fullHouse.bajiTeam - 1]++;
  const fullHouseResultMessage = fullHouse.result === 'SUCCESS'
    ? `टीम ${caller.teamId} ने Full House की सभी 13 चालें जीतीं।`
    : `टीम ${caller.teamId} Full House हार गई; ${
        room.roundEndReason === 'TWO_CONSECUTIVE_OPPOSING_TRICKS'
          ? 'विरोधी टीम ने लगातार 2 चालें जीतीं।'
          : 'सभी 13 चालें जीतने की शर्त पूरी नहीं हुई।'
      }`;
  room.roundMessage =
    `${fullHouseResultMessage} बोली: Full House; दंड: लागू नहीं। ` +
    `टीम ${fullHouse.bajiTeam} को 1 बाजी मिली। अपडेटेड स्कोर: ${room.gameScore}/52।`;
  room.scoreHistory.push({
    game: room.gameNumber,
    hand: room.handNumber,
    dealer: room.players[room.dealerIndex].name,
    bid: 'Full House',
    bidder: caller.name,
    fullHouseCaller: caller.name,
    fullHouseResult: fullHouse.result,
    startScore: room.gameScore,
    endScore: room.gameScore,
    nextDealer: room.players[room.dealerIndex].name
  });
  room.handNumber++;
  room.gameState = 'HAND_OVER';

  if (room.teamGameWins[fullHouse.bajiTeam - 1] >= 3) {
    room.gameState = 'MATCH_OVER';
    room.trophyWinner = fullHouse.bajiTeam;
  }

  room.currentTrick = [];
  room.pendingTricks = [];
  scheduleRoundResultTransition(room);
}

// SHARED SCORE CARD LOGIC
function evaluateSharedScoreRules(room) {
  if (room.handResultApplied) return;

  const dealerPlayer = room.players[room.dealerIndex];
  const bidWinnerPlayer = room.players[room.bidderIndex];

  if (!dealerPlayer || !bidWinnerPlayer) {
    room.handResultApplied = true;
    room.gameState = 'HAND_OVER';
    room.currentTrick = [];
    room.pendingTricks = [];
    return;
  }

  room.handResultApplied = true;
  const dealerTeam = dealerPlayer.teamId;
  const bidWinnerTeam = bidWinnerPlayer.teamId;

  const biddingTeamTricks = room.teamTricksWon[bidWinnerTeam - 1];
  const bidSuccess = biddingTeamTricks >= room.highestBid;

  const isShufflingTeamBidWinner = bidWinnerTeam === dealerTeam;
  const shufflingTeamWon = isShufflingTeamBidWinner
    ? bidSuccess
    : !bidSuccess;

  const initialScore = room.gameScore;
  const bid = room.highestBid;
  let newScore = initialScore;
  let dealerChanged = false;

  if (isShufflingTeamBidWinner) {
    if (shufflingTeamWon) {
      // शफलिंग टीम जीतती है: स्कोर से बोली घटेगी।
      newScore = initialScore - bid;
    } else {
      // शफलिंग टीम हारती है: स्कोर में बोली का दोगुना जुड़ेगा।
      newScore = initialScore + (bid * 2);
    }
  } else {
    if (!shufflingTeamWon) {
      newScore = initialScore + bid;
    } else {
      newScore = initialScore - (bid * 2);
    }
  }

  // Negative Score Rule
  if (newScore < 0) {
    newScore = Math.abs(newScore);
    room.dealerIndex = (room.dealerIndex + 3) % 4;
    dealerChanged = true;
  }

  room.gameScore = newScore;

  room.scoreHistory.push({
    game: room.gameNumber,
    hand: room.handNumber,
    dealer: dealerPlayer.name,
    bid: bid,
    bidder: bidWinnerPlayer.name,
    bidSuccess,
    biddingTeamTricks,
    shufflingTeamWon: shufflingTeamWon,
    startScore: initialScore,
    endScore: newScore,
    nextDealer: room.players[room.dealerIndex].name,
    ...(room.fullHouse ? {
      fullHouseCaller: room.players[room.fullHouse.callerSeat].name,
      fullHouseResult: room.fullHouse.result
    } : {})
  });

  room.handNumber++;

  // Game Limit: Score > 52
  if (room.gameScore > 52) {
    const victoriousTeam = dealerTeam === 1 ? 2 : 1;
    room.teamGameWins[victoriousTeam - 1]++;
    room.previousGameDeck = room.deck.map(card => ({ ...card }));

    // Trophy Condition: first team to 3 game wins.
    if (room.teamGameWins[0] >= 3) {
      room.gameState = 'MATCH_OVER';
      room.trophyWinner = 1;
    } else if (room.teamGameWins[1] >= 3) {
      room.gameState = 'MATCH_OVER';
      room.trophyWinner = 2;
    } else {
      room.gameScore = 0;
      room.gameNumber++;

      if (!dealerChanged) {
        room.dealerIndex = (room.dealerIndex + 3) % 4;
      }

      room.gameState = 'HAND_OVER';
    }
  } else {
    room.gameState = 'HAND_OVER';
  }

  const normalTrophyWinner = room.gameState === 'MATCH_OVER'
    ? room.trophyWinner
    : null;

  if (room.fullHouse && room.fullHouse.bajiTeam) {
    room.teamGameWins[room.fullHouse.bajiTeam - 1]++;
    if (
      !normalTrophyWinner &&
      room.teamGameWins[room.fullHouse.bajiTeam - 1] >= 3
    ) {
      room.gameState = 'MATCH_OVER';
      room.trophyWinner = room.fullHouse.bajiTeam;
    }
  }

  if (normalTrophyWinner) {
    room.gameState = 'MATCH_OVER';
    room.trophyWinner = normalTrophyWinner;
  }

  const lossConditionMessage = room.roundEndReason ===
    'TWO_CONSECUTIVE_OPPOSING_TRICKS'
    ? 'कारण: विरोधी टीम ने लगातार 2 चालें जीतीं।'
    : bidSuccess
      ? 'कारण: बोली पूरी हुई।'
      : 'कारण: बोली पूरी नहीं हुई।';
  const bidResultMessage = bidSuccess
    ? `टीम ${bidWinnerTeam} की बोली सफल रही (${bidWinnerPlayer.name}, बोली ${bid})।`
    : `टीम ${bidWinnerTeam} बोली में हार गई (${bidWinnerPlayer.name}, बोली ${bid}); ` +
      `2x दंड: ${bid * 2} अंक।`;
  const fullHouseResultMessage = room.fullHouse &&
    room.fullHouse.result === 'FAILED'
    ? `Full House हार गया: टीम ${room.players[room.fullHouse.callerSeat].teamId}। `
    : '';
  room.roundMessage =
    `${fullHouseResultMessage}${lossConditionMessage} ${bidResultMessage} ` +
    `अपडेटेड स्कोर: ${room.gameScore}/52।`;

  // हाथ/मैच समाप्त होने पर टेबल के कार्ड साफ करें।
  if (
    room.gameState === 'HAND_OVER' ||
    room.gameState === 'MATCH_OVER'
  ) {
    room.currentTrick = [];
    room.pendingTricks = [];
  }
  scheduleRoundResultTransition(room);
}

function sanitizeRoomState(room, viewerId) {
  const players = room.players.map(player => {
    const { reconnectToken, ...publicPlayer } = player;
    return {
      ...publicPlayer,
      hand: player.id === viewerId ? player.hand : []
    };
  });
  const fullHouse = room.fullHouse
    ? {
        ...room.fullHouse
      }
    : null;

  return {
    ...room,
    players,
    fullHouse,
    roundResultTimer: undefined,
    revealedFullHouseHands: room.fullHouse
      ? [
          {
            seat: room.fullHouse.callerSeat,
            hand: room.players[room.fullHouse.callerSeat]?.hand ?? []
          },
          {
            seat: room.fullHouse.partnerSeat,
            hand: room.players[room.fullHouse.partnerSeat]?.hand ?? []
          }
        ]
      : [],
    deck: undefined,
    reconnectTimers: undefined
  };
}

function broadcastRoomState(room) {
  room.players.forEach(player => {
    io.to(player.id).emit(
      'roomStateUpdate',
      sanitizeRoomState(room, player.id)
    );
  });
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
