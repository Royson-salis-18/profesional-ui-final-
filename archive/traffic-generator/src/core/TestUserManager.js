export class TestUserManager {
    static userIndex = 0;
    static getNextTestUser() {
        this.userIndex++;
        const timestamp = Date.now().toString().slice(-6);
        const username = `traffic_user_${this.userIndex}_${timestamp}`;
        const email = `${username}@traffic-test.local`;
        const password = process.env.TRAFFIC_TEST_USER_PASSWORD || 'TestUserPass123!';
        return {
            id: `user-${this.userIndex}-${timestamp}`,
            username,
            email,
            password,
        };
    }
    static getDeterministicUser(index = 1) {
        const username = `traffic_user_${index}`;
        const email = `traffic_user_${index}@traffic-test.local`;
        const password = process.env.TRAFFIC_TEST_USER_PASSWORD || 'TestUserPass123!';
        return {
            id: `user-${index}`,
            username,
            email,
            password,
        };
    }
}
//# sourceMappingURL=TestUserManager.js.map