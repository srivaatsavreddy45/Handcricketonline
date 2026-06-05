const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let players = [null, null]; // Strict slots: index 0 = Player 1, index 1 = Player 2
let gameState = {
    status: 'waiting',      // waiting, toss, toss-throw, decision, playing, gameover
    tossChoice: '',         // 'odd' or 'even'
    tossMoves: { p1: null, p2: null },
    battingPlayer: null,    // 'Player 1' or 'Player 2'
    bowlingPlayer: null,    // 'Player 1' or 'Player 2'
    target: null,
    score: 0,
    innings: 1,
    currentMoves: { p1: null, p2: null },
    lastBatNum: '-',
    lastBowlNum: '-',
    lastActionText: 'Connecting to Grandstand Server...',
    winnerRole: null,       // 'Player 1', 'Player 2', or 'tie'
    outcomeReason: ''
};

function resetGame() {
    gameState = {
        status: 'waiting', tossChoice: '', tossMoves: { p1: null, p2: null },
        battingPlayer: null, bowlingPlayer: null, target: null, score: 0, innings: 1,
        currentMoves: { p1: null, p2: null }, lastBatNum: '-', lastBowlNum: '-',
        lastActionText: 'Match reset. Awaiting standard roster configuration...',
        winnerRole: null, outcomeReason: ''
    };
    // Keep active sockets mapped, but clear their gameplay properties
}

function broadcastGameState() {
    io.emit('sync-lobby', {
        ...gameState,
        p1Connected: !!players[0],
        p2Connected: !!players[1]
    });
}

io.on('connection', (socket) => {
    // Dynamically assign an open structural slot
    let assignedIndex = -1;
    if (players[0] === null) {
        players[0] = socket.id;
        assignedIndex = 0;
    } else if (players[1] === null) {
        players[1] = socket.id;
        assignedIndex = 1;
    } else {
        socket.emit('error-msg', 'Stadium Arena is completely full.');
        socket.disconnect();
        return;
    }

    const myRoleString = assignedIndex === 0 ? 'Player 1' : 'Player 2';
    console.log(`${myRoleString} entered with Socket ID: ${socket.id}`);
    socket.emit('player-assignment', myRoleString);

    // Evaluate lobby readiness
    if (players[0] !== null && players[1] !== null) {
        if (gameState.status === 'waiting') {
            gameState.status = 'toss';
            gameState.lastActionText = "Both players on the pitch! Player 1, make the Toss Selection (Odd or Even).";
        }
    } else {
        gameState.status = 'waiting';
        gameState.lastActionText = "Waiting inside the locker room for Player 2...";
    }
    broadcastGameState();

    socket.on('request-sync', () => {
        socket.emit('player-assignment', myRoleString);
        broadcastGameState();
    });

    socket.on('toss-choice', (choice) => {
        if (socket.id === players[0] && gameState.status === 'toss') {
            gameState.tossChoice = choice;
            gameState.status = 'toss-throw';
            gameState.lastActionText = `Player 1 called ${choice.toUpperCase()}. Both players, enter a number (1-10) for the toss throw!`;
            broadcastGameState();
        }
    });

    socket.on('submit-number', (num) => {
        if (num < 1 || num > 10) return;

        const role = socket.id === players[0] ? 'p1' : 'p2';

        if (gameState.status === 'toss-throw') {
            gameState.tossMoves[role] = num;

            if (gameState.tossMoves.p1 !== null && gameState.tossMoves.p2 !== null) {
                const sum = gameState.tossMoves.p1 + gameState.tossMoves.p2;
                const isSumOdd = sum % 2 !== 0;
                const p1Won = (gameState.tossChoice === 'odd' && isSumOdd) || (gameState.tossChoice === 'even' && !isSumOdd);
                
                gameState.status = 'decision';
                const winnerName = p1Won ? "Player 1" : "Player 2";
                gameState.lastActionText = `Toss Results: ${gameState.tossMoves.p1} + ${gameState.tossMoves.p2} = ${sum} (${isSumOdd ? 'ODD' : 'EVEN'}). ${winnerName} Wins the Toss!`;
            } else {
                gameState.lastActionText = `${role === 'p1' ? 'Player 1' : 'Player 2'} threw down. Waiting for opponent's toss count...`;
            }
            broadcastGameState();
        } 
        else if (gameState.status === 'playing') {
            gameState.currentMoves[role] = num;

            if (gameState.currentMoves.p1 !== null && gameState.currentMoves.p2 !== null) {
                const batNum = gameState.battingPlayer === 'Player 1' ? gameState.currentMoves.p1 : gameState.currentMoves.p2;
                const bowlNum = gameState.bowlingPlayer === 'Player 1' ? gameState.currentMoves.p1 : gameState.currentMoves.p2;
                
                gameState.lastBatNum = batNum;
                gameState.lastBowlNum = bowlNum;

                if (batNum === bowlNum) {
                    if (gameState.innings === 1) {
                        gameState.target = gameState.score + 1;
                        gameState.lastActionText = `💥 OUT! Batter matched ${batNum}. Target set to ${gameState.target}. Commencing Innings 2!`;
                        
                        // Swap Stances systematically
                        const oldBatter = gameState.battingPlayer;
                        gameState.battingPlayer = gameState.bowlingPlayer;
                        gameState.bowlingPlayer = oldBatter;
                        
                        gameState.score = 0;
                        gameState.innings = 2;
                    } else {
                        gameState.status = 'gameover';
                        if (gameState.score === gameState.target - 1) {
                            gameState.outcomeReason = "tie";
                            gameState.winnerRole = "tie";
                            gameState.lastActionText = "🏁 MATCH OVER: It's a precise TIE!";
                        } else {
                            gameState.outcomeReason = "defended";
                            gameState.winnerRole = gameState.bowlingPlayer;
                            gameState.lastActionText = `🏁 MATCH OVER: ${gameState.bowlingPlayer} successfully defended the total target!`;
                        }
                    }
                } else {
                    gameState.score += batNum;
                    gameState.lastActionText = `Delivery safe! Batter scores +${batNum} runs.`;

                    if (gameState.innings === 2 && gameState.score >= gameState.target) {
                        gameState.status = 'gameover';
                        gameState.outcomeReason = "chased";
                        gameState.winnerRole = gameState.battingPlayer;
                        gameState.lastActionText = `🏁 MATCH OVER: ${gameState.battingPlayer} successfully chased the target!`;
                    }
                }
                // Clear inputs completely for next delivery cycle
                gameState.currentMoves = { p1: null, p2: null };
            } else {
                gameState.lastActionText = `${role === 'p1' ? 'Player 1' : 'Player 2'} logged delivery value. Awaiting opponent selection...`;
            }
            broadcastGameState();
        }
    });

    socket.on('toss-decision', (decision) => {
        if (gameState.status === 'decision') {
            // Determine who won the toss based on lastActionText context
            const p1WonToss = gameState.lastActionText.includes("Player 1 Wins");
            const decisionMaker = p1WonToss ? 'Player 1' : 'Player 2';
            const opponentName = p1WonToss ? 'Player 2' : 'Player 1';

            if (decision === 'bat') {
                gameState.battingPlayer = decisionMaker;
                gameState.bowlingPlayer = opponentName;
            } else {
                gameState.bowlingPlayer = decisionMaker;
                gameState.battingPlayer = opponentName;
            }
            gameState.status = 'playing';
            gameState.lastActionText = `Match Started! ${gameState.battingPlayer} is Batting, ${gameState.bowlingPlayer} is Bowling.`;
            broadcastGameState();
        }
    });

    socket.on('force-restart', () => {
        console.log("Match hard-reset requested.");
        resetGame();
        if (players[0] && players[1]) {
            gameState.status = 'toss';
            gameState.lastActionText = "Arena manually reset! Player 1, make the Toss Selection.";
        }
        broadcastGameState();
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        if (assignedIndex !== -1) {
            players[assignedIndex] = null;
        }
        resetGame();
        broadcastGameState();
    });
});

http.listen(3000, () => {
    console.log('Server is rock-solid at http://localhost:3000');
});