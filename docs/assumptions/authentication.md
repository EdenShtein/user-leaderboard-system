# Authentication & Authorization

## Decision

Authentication is **intentionally omitted** from the implementation. This document explains the security concern, the solution design, and why it was deferred.

## The Problem

Without authentication, any client can:

- **Update any user's score** — `PATCH /api/users/:id/score` accepts any UUID, enabling score tampering
- **Create fake users** — `POST /api/users` has no identity verification
- **Enumerate users** — leaderboard endpoints expose user IDs that can be used in write operations

In a production gaming leaderboard, this is a critical vulnerability. A malicious actor could set their score to `999999999` or reset a competitor's score to `0`.

## Proposed Solution: JWT + Role-Based Access

### Architecture

```
Client → API Gateway (JWT validation) → Leaderboard API → PostgreSQL / Redis
```

### Token Flow

1. **Game server** authenticates the user (OAuth2, session, etc.) and issues a signed JWT containing:
   ```json
   {
     "sub": "user-uuid-here",
     "role": "player",
     "iat": 1700000000,
     "exp": 1700003600
   }
   ```

2. **Leaderboard API** validates the JWT on every request using a shared secret or public key (RS256).

3. **Authorization rules:**

   | Endpoint | Rule |
   |----------|------|
   | `POST /api/users` | Requires `admin` or `server` role |
   | `PATCH /api/users/:id/score` | Requires `server` role, OR `player` role where `jwt.sub === :id` |
   | `GET /api/leaderboard/top` | Public (no auth required) |
   | `GET /api/leaderboard/user/:id` | Public or authenticated |

### Implementation Sketch (NestJS)

```typescript
// auth.guard.ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new UnauthorizedException();

    const payload = verify(token, process.env.JWT_SECRET);
    request.user = payload;
    return true;
  }
}

// score-owner.guard.ts — ensures users can only update their own score
@Injectable()
export class ScoreOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const { user } = request;
    const targetId = request.params.id;

    if (user.role === 'server') return true; // game server can update any score
    if (user.sub === targetId) return true;   // user can update their own score

    throw new ForbiddenException('Cannot update another user\'s score');
  }
}
```

### NestJS Integration

```typescript
@Patch(':id/score')
@UseGuards(JwtAuthGuard, ScoreOwnerGuard)
updateScore(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateScoreDto) {
  return this.usersService.updateScore(id, dto.score);
}
```

### Production Considerations

- **Game server as the score authority:** In most gaming architectures, the game server — not the client — submits score updates. The client never calls `PATCH /api/users/:id/score` directly. This makes `server` role auth the primary pattern, with client-side JWT as a secondary concern.
- **Rate limiting per user:** Combine JWT `sub` with `@nestjs/throttler` to rate-limit per user, not just per IP. Prevents a single authenticated user from flooding the API.
- **Token rotation:** Short-lived access tokens (15 min) + refresh tokens. The leaderboard API only validates access tokens — it doesn't issue them.
- **API Gateway offloading:** In the AWS architecture, JWT validation can happen at the ALB or API Gateway level, keeping the application stateless and reducing per-request overhead.

## Why It Was Deferred

1. **Not in the assignment requirements.** The specification asks for 4 API endpoints, a database schema, Redis caching, and AWS architecture — authentication is not listed.
2. **Time constraint.** The estimated time is 4 hours. Implementing JWT (guard, strategy, module, tests, key management) adds 1-2 hours of complexity.
3. **Orthogonal concern.** Auth is a cross-cutting infrastructure concern that doesn't affect the leaderboard's data structure design, which is the core evaluation criteria.
4. **Read endpoints are safe.** The leaderboard read endpoints (`GET /top`, `GET /user/:id`) expose only public data (name, score, rank) — no sensitive information is leaked.

## When to Implement

- Before any public deployment or external API access
- When integrating with a real game server authentication system
- As part of a broader API gateway / microservice auth strategy
