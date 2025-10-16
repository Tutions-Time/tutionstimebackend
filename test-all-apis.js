const axios = require('axios');

const API_URL = 'http://localhost:5000/api';
let requestId, accessToken, userId;

// Test configuration
const testPhone = '9876543210';
const testOtp = '123456'; // Mock OTP for testing

// Helper function to log test results
const logTest = (name, success, data = null, error = null) => {
  console.log(`\n----- ${name} -----`);
  console.log(`Status: ${success ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  if (data) console.log('Response:', JSON.stringify(data, null, 2));
  if (error) console.log('Error:', error.message || error);
};

// Run tests sequentially
const runTests = async () => {
  try {
    console.log('\n===== TESTING ALL APIS =====');
    
    // 1. Authentication Tests
    console.log('\n===== AUTHENTICATION TESTS =====');
    
    // 1.1 Test endpoint
    try {
      console.log('\nTesting basic API endpoint...');
      const testResponse = await axios.get(`${API_URL}/test`);
      logTest('Basic API Test', true, testResponse.data);
    } catch (error) {
      logTest('Basic API Test', false, null, error);
    }
    
    // 1.2 Send OTP
    try {
      console.log('\nSending OTP for signup...');
      const sendOtpResponse = await axios.post(`${API_URL}/auth/send-otp`, {
        phone: testPhone,
        purpose: 'signup'
      });
      
      requestId = sendOtpResponse.data.requestId;
      logTest('Send OTP', true, sendOtpResponse.data);
    } catch (error) {
      logTest('Send OTP', false, null, error);
      console.error('AUTH TEST ERROR - Cannot continue tests without authentication');
      return;
    }
    
    // 1.3 Verify OTP (this will likely fail in test environment without real OTP)
    try {
      console.log('\nVerifying OTP (mock)...');
      const verifyOtpResponse = await axios.post(`${API_URL}/auth/verify-otp`, {
        phone: testPhone,
        otp: testOtp,
        requestId,
        role: 'student'
      });
      
      accessToken = verifyOtpResponse.data.tokens.accessToken;
      userId = verifyOtpResponse.data.user.id;
      logTest('Verify OTP', true, verifyOtpResponse.data);
    } catch (error) {
      // Since OTP verification might fail in test environment, we'll continue with a mock token
      logTest('Verify OTP', false, null, error);
      console.log('\nContinuing tests with mock authentication...');
      
      // For testing purposes only - in a real environment, we would stop here
      accessToken = 'mock_token_for_testing';
    }
    
    // 2. Subject API Tests
    console.log('\n===== SUBJECT API TESTS =====');
    
    // 2.1 Get all subjects
    try {
      console.log('\nGetting all subjects...');
      const getSubjectsResponse = await axios.get(`${API_URL}/subjects`);
      logTest('Get Subjects', true, getSubjectsResponse.data);
    } catch (error) {
      logTest('Get Subjects', false, null, error);
    }
    
    // 3. User Profile Tests (requires authentication)
    if (accessToken !== 'mock_token_for_testing') {
      console.log('\n===== USER PROFILE TESTS =====');
      
      // 3.1 Get user profile
      try {
        console.log('\nGetting user profile...');
        const getProfileResponse = await axios.get(`${API_URL}/users/profile`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        logTest('Get User Profile', true, getProfileResponse.data);
      } catch (error) {
        logTest('Get User Profile', false, null, error);
      }
    }
    
    // 4. Booking API Tests (requires authentication)
    if (accessToken !== 'mock_token_for_testing') {
      console.log('\n===== BOOKING API TESTS =====');
      
      // 4.1 Get user bookings
      try {
        console.log('\nGetting user bookings...');
        const getBookingsResponse = await axios.get(`${API_URL}/bookings`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        logTest('Get User Bookings', true, getBookingsResponse.data);
      } catch (error) {
        logTest('Get User Bookings', false, null, error);
      }
    }
    
    // 5. Wallet API Tests (requires authentication)
    if (accessToken !== 'mock_token_for_testing') {
      console.log('\n===== WALLET API TESTS =====');
      
      // 5.1 Get wallet balance
      try {
        console.log('\nGetting wallet balance...');
        const getWalletResponse = await axios.get(`${API_URL}/wallet/balance`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        logTest('Get Wallet Balance', true, getWalletResponse.data);
      } catch (error) {
        logTest('Get Wallet Balance', false, null, error);
      }
      
      // 5.2 Get transaction history
      try {
        console.log('\nGetting transaction history...');
        const getTransactionsResponse = await axios.get(`${API_URL}/wallet/transactions`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        logTest('Get Transactions', true, getTransactionsResponse.data);
      } catch (error) {
        logTest('Get Transactions', false, null, error);
      }
    }
    
    console.log('\n===== ALL TESTS COMPLETED =====');
    
  } catch (error) {
    console.error('Test execution error:', error.message);
  }
};

// Run the tests
runTests();