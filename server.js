
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

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
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = (roomCode || 'DEFAULT').toUpperCase();
    socket.join(code);

    if (!rooms[code]) {
      rooms[code] = {
        roomCode: code,
        players: [],
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
        roundMessage: null
      };
    }

    const room = rooms[code];

    if (
      room.players.length < 4 &&
      !room.players.some(p => p.id === socket.id)
    ) {
      const seatIndex = room.players.length;
      const teamId = (seatIndex === 0 || seatIndex === 2) ? 1 : 2;

      room.players.push({
        id: socket.id,
        name: playerName || `Player ${seatIndex + 1}`,
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
    }

    broadcastRoomState(room);
  });

  socket.on('selectTeammate', ({ roomCode, teammateId }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'LOBBY' ||
      room.hostId !== socket.id ||
      room.players.length !== 4 ||
      typeof teammateId !== 'string' ||
      teammateId === socket.id
    ) return;

    const teammate = room.players.find(player => player.id === teammateId);
    if (!teammate) return;

    room.selectedPartnerId = teammateId;
    room.players.forEach(player => {
      player.teamId =
        player.id === socket.id || player.id === teammateId ? 1 : 2;
    });
    broadcastRoomState(room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'LOBBY' ||
      room.hostId !== socket.id ||
      room.players.length !== 4 ||
      !room.selectedPartnerId ||
      !room.players.some(player => player.id === room.selectedPartnerId)
    ) return;

    room.roomMessage = null;
    startNewHand(room);
    broadcastRoomState(room);
  });

  socket.on('placeBid', ({ roomCode, bid, passed }) => {
    const room = rooms[roomCode];
    if (
      !room ||
      room.gameState !== 'AUCTION' ||
      room.auctionTurnCount >= 4
    ) return;

    const currentPlayer = room.players[room.auctionTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    if (passed) {
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
      room.auctionTurnIndex = (room.auctionTurnIndex + 1) % 4;
    }

    broadcastRoomState(room);
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
        status: 'ACTIVE',
        partnerHand: []
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
        status: 'ACTIVE',
        partnerHand: [...room.players[getPartnerSeat(room, caller.seatIndex)].hand]
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

    if (room.fullHouse && room.fullHouse.phase === 'INITIAL') {
      room.fullHouse.partnerHand = [
        ...room.players[room.fullHouse.partnerSeat].hand
      ];
    }

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

    if (!room || room.gameState !== 'PLAYING') return;
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
      room.turnIndex = (room.turnIndex + 1) % 4;
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

    if (room && room.gameState === 'HAND_OVER') {
      startNewHand(room);
      broadcastRoomState(room);
    }
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);

      if (pIdx !== -1) {
        const departedPlayer = room.players[pIdx];
        room.players.splice(pIdx, 1);
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
        room.dealerIndex = 0;
        room.scoreHistory = [];
        room.currentTrick = [];
        room.pendingTricks = [];
        room.teamTricksWon = [0, 0];
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
        room.roomMessage = `${departedPlayer.name} छोड़कर चले गए। खेल रोक दिया गया है; नए खिलाड़ी के जुड़ने पर नया गेम शुरू होगा।`;

        broadcastRoomState(room);
      }
    }
  });
});

function startNewHand(room) {
  room.gameState = 'AUCTION';
  room.deck = generateDeck();
  room.currentTrick = [];
  room.pendingTricks = [];
  room.teamTricksWon = [0, 0];
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

  if (room.fullHouse) {
    const caller = room.players[room.fullHouse.callerSeat];
    if (caller && room.teamTricksWon[2 - caller.teamId] > 0) {
      resolveFullHouse(room);
      room.roundMessage =
        'Your Full House is broken! The opposing team wins 1 Baji point.';
      if (room.fullHouse.phase === 'INITIAL') {
        finishInitialFullHouse(room);
      } else {
        evaluateSharedScoreRules(room);
      }
      broadcastRoomState(room);
      return;
    }
  } else {
    const bidder = room.players[room.bidderIndex];
    if (bidder && Number.isInteger(room.highestBid)) {
      const opposingTeamTricks = room.teamTricksWon[2 - bidder.teamId];
      const defeatThreshold = 14 - room.highestBid;
      if (opposingTeamTricks >= defeatThreshold) {
        room.roundMessage =
          `The bidding team is defeated! The opposing team reached the ${defeatThreshold}-trick threshold.`;
        evaluateSharedScoreRules(room);
        broadcastRoomState(room);
        return;
      }
    }
  }

  if (room.trickNo < 13) {
    room.trickNo++;
  } else {
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
      'Full House successful! The caller’s team wins all 13 tricks and 1 Baji point.';
  } else {
    room.roundMessage =
      'Your Full House is broken! The opposing team wins 1 Baji point.';
  }
}

function finishInitialFullHouse(room) {
  const fullHouse = room.fullHouse;
  const caller = room.players[fullHouse.callerSeat];
  if (!caller || !fullHouse.bajiTeam) {
    room.gameState = 'HAND_OVER';
    return;
  }

  room.teamGameWins[fullHouse.bajiTeam - 1]++;
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
}

// SHARED SCORE CARD LOGIC
function evaluateSharedScoreRules(room) {
  const dealerPlayer = room.players[room.dealerIndex];
  const bidWinnerPlayer = room.players[room.bidderIndex];

  if (!dealerPlayer || !bidWinnerPlayer) {
    room.gameState = 'HAND_OVER';
    room.currentTrick = [];
    room.pendingTricks = [];
    return;
  }

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
    room.dealerIndex = (room.dealerIndex + 1) % 4;
    dealerChanged = true;
  }

  room.gameScore = newScore;

  room.scoreHistory.push({
    game: room.gameNumber,
    hand: room.handNumber,
    dealer: dealerPlayer.name,
    bid: bid,
    bidder: bidWinnerPlayer.name,
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
        room.dealerIndex = (room.dealerIndex + 1) % 4;
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

  // हाथ/मैच समाप्त होने पर टेबल के कार्ड साफ करें।
  if (
    room.gameState === 'HAND_OVER' ||
    room.gameState === 'MATCH_OVER'
  ) {
    room.currentTrick = [];
    room.pendingTricks = [];
  }
}

function sanitizeRoomState(room, viewerId) {
  const players = room.players.map(player => ({
    ...player,
    hand: player.id === viewerId ? player.hand : []
  }));
  const fullHouse = room.fullHouse
    ? {
        ...room.fullHouse,
        partnerHand: undefined
      }
    : null;

  return {
    ...room,
    players,
    fullHouse,
    revealedPartnerHand: room.fullHouse
      ? room.fullHouse.partnerHand
      : [],
    deck: undefined
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
