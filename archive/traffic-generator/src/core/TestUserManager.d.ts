export interface TestUser {
    id: string;
    username: string;
    email: string;
    password: string;
}
export declare class TestUserManager {
    private static userIndex;
    static getNextTestUser(): TestUser;
    static getDeterministicUser(index?: number): TestUser;
}
