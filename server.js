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
      if (winningPlay.card.suit !== trumpSuit || play.card.value > winningPlay.card.value) {
        winningPlay = play;
      }
    } else if (play.card.suit === ledSuit && winningPlay.card.suit === ledSuit) {
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
        gameNumber: 1,
        handNumber: 1,
        gameState: 'LOBBY', // LOBBY, AUCTION, TRUMP_SELECT, PLAYING, HAND_OVER, MATCH_OVER
        gameScore: 0,       // Single common score card
        teamGameWins: [0, 0], // Game wins toward 3-Game Trophy
        dealerIndex: 0,     // Current player shuffling/dealing
        scoreHistory: [],
        currentTrick: [],
        trickNo: 1,
        pot: 0,
        lastWinner: null,
        leadIndex: 0,
        turnIndex: 0,
        highestBid: 7,
        bidderIndex: -1,
        auctionTurnIndex: 0,
        trumpSuit: null,
        trophyWinner: null,
        deck: []
      };
    }

    const room = rooms[code];

    if (room.players.length < 4 && !room.players.some(p => p.id === socket.id)) {
      const seatIndex = room.players.length;
      const teamId = (seatIndex === 0 || seatIndex === 2) ? 1 : 2; // Team 1: P0, P2 | Team 2: P1, P3
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
    }

    if (room.players.length === 4 && room.gameState === 'LOBBY') {
      startNewHand(room);
    }

    io.to(code).emit('roomStateUpdate', sanitizeRoomState(room));
  });

  socket.on('placeBid', ({ roomCode, bid, passed }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'AUCTION') return;

    const currentPlayer = room.players[room.auctionTurnIndex];
    if (currentPlayer.id !== socket.id) return;

    if (passed) {
      currentPlayer.hasPassed = true;
    } else if (bid > room.highestBid && bid <= 13) {
      room.highestBid = bid;
      room.bidderIndex = room.auctionTurnIndex;
      currentPlayer.currentBid = bid;
    }

    const activeBidders = room.players.filter(p => !p.hasPassed);
    if ((activeBidders.length === 1 && room.bidderIndex !== -1) || room.highestBid === 13) {
      room.gameState = 'TRUMP_SELECT';
    } else if (activeBidders.length === 0 && room.bidderIndex === -1) {
      room.bidderIndex = room.dealerIndex;
      room.highestBid = 8;
      room.players[room.bidderIndex].currentBid = 8;
      room.gameState = 'TRUMP_SELECT';
    } else {
      let nextTurn = (room.auctionTurnIndex + 1) % 4;
      let guard = 0;
      while (room.players[nextTurn].hasPassed && guard++ < 4) {
        nextTurn = (nextTurn + 1) % 4;
      }
      room.auctionTurnIndex = nextTurn;
    }

    io.to(roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
  });

  socket.on('selectTrump', ({ roomCode, suitIndex }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'TRUMP_SELECT') return;

    const winningBidder = room.players[room.bidderIndex];
    if (winningBidder.id !== socket.id) return;

    room.trumpSuit = suitIndex;
    distributeRemainingCards(room);

    room.gameState = 'PLAYING';
    room.turnIndex = room.dealerIndex;
    room.leadIndex = room.dealerIndex;

    io.to(roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
  });

  socket.on('playCard', ({ roomCode, card }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'PLAYING') return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const validMoves = getValidMoves(currentPlayer.hand, room.currentTrick);
    const isValid = validMoves.some(c => c.suit === card.suit && c.value === card.value);
    if (!isValid) return;

    const cardIdx = currentPlayer.hand.findIndex(c => c.suit === card.suit && c.value === card.value);
    currentPlayer.hand.splice(cardIdx, 1);

    room.currentTrick.push({
      playerIndex: currentPlayer.seatIndex,
      card
    });

    if (room.currentTrick.length < 4) {
      room.turnIndex = (room.turnIndex + 1) % 4;
      io.to(roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
    } else {
      io.to(roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
      setTimeout(() => {
        resolveTrick(room);
      }, 1200);
    }
  });

  socket.on('nextHand', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.gameState === 'HAND_OVER') {
      startNewHand(room);
      io.to(roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
    }
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
        room.gameState = 'LOBBY';
        io.to(code).emit('roomStateUpdate', sanitizeRoomState(room));
      }
    }
  });
});

function startNewHand(room) {
  room.gameState = 'AUCTION';
  room.deck = generateDeck();
  room.currentTrick = [];
  room.trickNo = 1;
  room.pot = 0;
  room.lastWinner = null;
  room.highestBid = 7;
  room.bidderIndex = -1;
  room.trumpSuit = null;

  room.auctionTurnIndex = room.dealerIndex;
  room.turnIndex = room.dealerIndex;

  room.players.forEach((p, idx) => {
    p.hand = room.deck.slice(idx * 5, (idx + 1) * 5).sort((a, b) => a.suit - b.suit || a.value - b.value);
    p.tricksWon = 0;
    p.hasPassed = false;
    p.currentBid = 0;
  });
}

function distributeRemainingCards(room) {
  const remainingDeck = room.deck.slice(20);
  room.players.forEach((p, idx) => {
    const extraCards = remainingDeck.slice(idx * 8, (idx + 1) * 8);
    p.hand = [...p.hand, ...extraCards].sort((a, b) => a.suit - b.suit || a.value - b.value);
  });
}

function resolveTrick(room) {
  const winnerSeat = resolveTrickWinner(room.currentTrick, room.trumpSuit);
  const winner = room.players[winnerSeat];
  room.pot++;

  if (room.lastWinner === winnerSeat) {
    winner.tricksWon += room.pot;
    room.pot = 0;
    room.lastWinner = null;
  } else {
    room.lastWinner = winnerSeat;
  }

  if (room.trickNo === 13 && room.pot > 0) {
    winner.tricksWon += room.pot;
    room.pot = 0;
  }

  room.currentTrick = [];
  room.turnIndex = winnerSeat;
  room.leadIndex = winnerSeat;

  if (room.trickNo < 13) {
    room.trickNo++;
  } else {
    evaluateSharedScoreRules(room);
  }

  io.to(room.roomCode).emit('roomStateUpdate', sanitizeRoomState(room));
}

// SHARED SCORE CARD LOGIC IMPLEMENTATION
function evaluateSharedScoreRules(room) {
  const dealerPlayer = room.players[room.dealerIndex];
  const dealerTeam = dealerPlayer.teamId; // Shuffling Team
  const bidWinnerPlayer = room.players[room.bidderIndex];
  const bidWinnerTeam = bidWinnerPlayer.teamId;

  const t1Tricks = room.players[0].tricksWon + room.players[2].tricksWon;
  const t2Tricks = room.players[1].tricksWon + room.players[3].tricksWon;

  const biddingTeamTricks = bidWinnerTeam === 1 ? t1Tricks : t2Tricks;
  const bidSuccess = biddingTeamTricks >= room.highestBid;

  const isShufflingTeamBidWinner = (bidWinnerTeam === dealerTeam);
  const shufflingTeamWon = isShufflingTeamBidWinner ? bidSuccess : !bidSuccess;

  const initialScore = room.gameScore;
  const bid = room.highestBid;
  let newScore = initialScore;
  let dealerChanged = false;

  if (isShufflingTeamBidWinner) {
    if (shufflingTeamWon) {
      // Rule 2: Shuffling Team Wins -> Score = Score - Bid
      newScore = initialScore - bid;
    } else {
      // Rule 3: Shuffling Team Loses -> Score = Score + (Bid * 2), Same player continues
      newScore = initialScore + (bid * 2);
    }
  } else {
    if (!shufflingTeamWon) {
      // Rule 4: Opposition Team Wins -> Score = Score + Bid
      newScore = initialScore + bid;
    } else {
      // Rule 5: Opposition Team Loses -> Score = Score - (Bid * 2)
      newScore = initialScore - (bid * 2);
    }
  }

  // Rule 6: Negative Score Rule
  if (newScore < 0) {
    newScore = Math.abs(newScore);
    room.dealerIndex = (room.dealerIndex + 1) % 4; // Turn ends, move to next player
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
    nextDealer: room.players[room.dealerIndex].name
  });

  room.handNumber++;

  // Rule 9: Game Limit (Score > 52)
  if (room.gameScore > 52) {
    // Current game ends. Winning team gets +1 Game Win point.
    const victoriousTeam = dealerTeam === 1 ? 2 : 1;
    room.teamGameWins[victoriousTeam - 1]++;

    // Rule 10: Trophy Condition (First to 3 Game Wins)
    if (room.teamGameWins[0] >= 3) {
      room.gameState = 'MATCH_OVER';
      room.trophyWinner = 1;
    } else if (room.teamGameWins[1] >= 3) {
      room.gameState = 'MATCH_OVER';
      room.trophyWinner = 2;
    } else {
      room.gameScore = 0;
      room.gameNumber++;
      // Opposition player becomes starting player for next game
      if (!dealerChanged) {
        room.dealerIndex = (room.dealerIndex + 1) % 4;
      }
      room.gameState = 'HAND_OVER';
    }
  } else {
    room.gameState = 'HAND_OVER';
  }
}

function sanitizeRoomState(room) {
  return { ...room, deck: undefined };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});