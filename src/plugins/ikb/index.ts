import {
  Content,
  IAgentRuntime,
  Memory,
  State,
  ActionExample,
} from "@ai16z/eliza";
import {
  SearchPlugin,
  SearchPluginConfig,
  SearchResult,
  SearchAction,
} from "../../common/types.ts";
import {
  validateApiKey,
  validateSearchQuery,
  handleApiError,
  formatSearchResults,
  createRateLimiter,
} from "../../common/utils.ts";

interface IKBPlayerStats {
  name: string;
  position: string;
  played: boolean;
  started: number;
  minutes: number;
  seconds: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blockedShots: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  threePointersMade: number;
  threePointersAttempted: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
  fantasyPoints: number;
}

interface IKBTeamStats {
  name: string;
  abbreviation: string;
  score: number;
  fieldGoalsPercentage: number;
  threePointersPercentage: number;
  rebounds: number;
  assists: number;
  steals: number;
  blockedShots: number;
  turnovers: number;
}

interface IKBGameData {
  game: {
    season: number;
    status: string;
    dateTime: string;
    awayTeam: string;
    homeTeam: string;
    awayTeamScore: number;
    homeTeamScore: number;
    stadium: string;
    quarters: Array<{
      number: number;
      awayScore: number;
      homeScore: number;
    }>;
  };
  teams: IKBTeamStats[];
  players: IKBPlayerStats[];
}

interface IKBSearchResponse {
  data: IKBGameData[];
  metadata: {
    count: number;
  };
}

export interface IKBPluginConfig extends SearchPluginConfig {
  searchType?: "game" | "teams" | "players";
  filters?: {
    sport: "nfl" | "nba";
    date: string; // YYYY-MM-DD format
  };
}

const DEFAULT_CONFIG: Partial<IKBPluginConfig> = {
  maxResults: 5,
  searchType: "game",
};

interface IKBMemory {
  content: {
    text: string;
    sport: "nfl" | "nba";
    date: string;
    data: IKBGameData[];
  };
  roomId: string;
  userId: string;
}

export class IKBSearchPlugin implements SearchPlugin {
  readonly name: string = "ikb-sports";
  readonly description: string = "Search NBA and NFL statistics using IKB API";
  config: IKBPluginConfig;
  private rateLimiter = createRateLimiter(60, 60000);

  constructor(config: IKBPluginConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateApiKey(this.config);
  }

  private formatGameSummary(data: IKBGameData): string {
    const game = data.game;
    const quarters = game.quarters.map(q => 
      `Q${q.number}: ${q.awayScore}-${q.homeScore}`
    ).join(', ');

    return `${game.awayTeam} ${game.awayTeamScore} @ ${game.homeTeam} ${game.homeTeamScore}\n` +
           `Date: ${new Date(game.dateTime).toLocaleDateString()}\n` +
           `Quarter Scores: ${quarters}\n` +
           `Status: ${game.status}\n` +
           `Stadium: ${game.stadium}`;
  }

  private formatTeamStats(data: IKBGameData): string {
    return data.teams.map(team => 
      `${team.name} (${team.abbreviation})\n` +
      `Score: ${team.score}\n` +
      `FG%: ${team.fieldGoalsPercentage.toFixed(1)}%, 3P%: ${team.threePointersPercentage.toFixed(1)}%\n` +
      `Rebounds: ${team.rebounds}, Assists: ${team.assists}\n` +
      `Steals: ${team.steals}, Blocks: ${team.blockedShots}`
    ).join('\n\n');
  }

  private formatPlayerStats(data: IKBGameData): string {
    return data.players
      .filter(p => p.played)
      .sort((a, b) => (b.fantasyPoints || 0) - (a.fantasyPoints || 0))
      .slice(0, 10)
      .map(player => {
        const minutes = `${player.minutes}:${player.seconds.toString().padStart(2, '0')}`;
        const shooting = `${player.fieldGoalsMade}/${player.fieldGoalsAttempted} FG, ` +
                        `${player.threePointersMade}/${player.threePointersAttempted} 3P`;
        return `${player.name} (${player.position}) - ${minutes} min\n` +
               `${player.points} PTS, ${player.rebounds} REB, ${player.assists} AST\n` +
               `${shooting}`;
      }).join('\n\n');
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private extractDateFromQuery(query: string): string {
    const dateMatch = query.match(/\d{4}-\d{2}-\d{2}/);
    if (dateMatch) return dateMatch[0];
    return this.formatDate(new Date());
  }

  private extractSportFromQuery(query: string): "nfl" | "nba" {
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.includes("nfl") || lowerQuery.includes("football")) return "nfl";
    if (lowerQuery.includes("nba") || lowerQuery.includes("basketball")) return "nba";
    return "nba";
  }

  private async memorizeData(runtime: IAgentRuntime, sport: string, date: string, data: IKBGameData[]): Promise<void> {
    const memory: IKBMemory = {
      content: {
        text: `${sport} game data for ${date}`,
        sport: sport as "nfl" | "nba",
        date,
        data
      },
      roomId: "default",
      userId: "system"
    };

    const memoryManager = await runtime.getMemoryManager();
    await memoryManager.createMemory(memory, { embed: true });
  }

  private async fetchFromAPI(sport: string, date: string): Promise<IKBSearchResponse> {
    const response = await fetch(`https://api.ikb.gg/ai/${sport}/${date}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`IKB API error: ${response.statusText}`);
    }

    return response.json();
  }

  actions: SearchAction[] = [
    {
      name: "IKB_SEARCH",
      description: "Search NBA and NFL game statistics and player data",
      examples: [
        [
          {
            user: "user",
            content: { text: "Get NBA games for 2024-12-15" },
          },
        ],
        [
          {
            user: "user",
            content: { text: "Show me NFL stats from 2024-12-22" },
          },
        ],
      ],
      similes: ["ikb", "nba stats", "nfl stats", "sports data"],
      validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
      ) => {
        try {
          validateSearchQuery(message.content.text);
          return true;
        } catch {
          return false;
        }
      },
      handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
      ): Promise<{
        success: boolean;
        response: string;
      }> => {
        try {
          if (!this.rateLimiter.checkLimit()) {
            return {
              success: false,
              response: "Rate limit exceeded. Please try again later.",
            };
          }

          const query = validateSearchQuery(message.content.text);
          const date = this.extractDateFromQuery(query);
          const sport = this.extractSportFromQuery(query);

          const data = await this.fetchFromAPI(sport, date);
          
          await this.memorizeData(runtime, sport, date, data.data);

          let formattedContent = '';
          if (data.data.length > 0) {
            const gameData = data.data[0];
            switch (this.config.searchType) {
              case 'game':
                formattedContent = this.formatGameSummary(gameData);
                break;
              case 'teams':
                formattedContent = this.formatTeamStats(gameData);
                break;
              case 'players':
                formattedContent = this.formatPlayerStats(gameData);
                break;
              default:
                formattedContent = this.formatGameSummary(gameData);
            }
          }

          const results: SearchResult[] = [{
            title: `${sport.toUpperCase()} Stats for ${date}`,
            url: `https://api.ikb.gg/ai/${sport}/${date}`,
            snippet: formattedContent,
            score: 1,
            source: "ikb",
            metadata: {
              sport,
              date,
              dataType: this.config.searchType
            }
          }];

          return {
            success: true,
            response: formatSearchResults(results),
          };
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  ];
}

export default new IKBSearchPlugin({
  apiKey: process.env.IKB_API_KEY || "",
  searchType: "game",
  filters: {
    sport: "nba",
    date: new Date().toISOString().split('T')[0]
  }
}); 