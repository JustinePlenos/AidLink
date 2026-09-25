import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { PieChart, Pie, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';
import { getRequests } from '../api';
import type { AssistanceRequest } from '../types';

export function AnalyticsCharts() {
  const [requests, setRequests] = useState<AssistanceRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadRequests = async () => {
      try {
        const data = await getRequests();
        setRequests(data);
      } catch {
        setRequests([]);
      } finally {
        setLoading(false);
      }
    };

    loadRequests();
  }, []);

  // Status Distribution Data
  const statusData = [
    { name: 'Pending', value: requests.filter((r) => r.status === 'pending').length, color: '#fbbf24' },
    { name: 'Approved', value: requests.filter((r) => r.status === 'approved').length, color: '#8b5cf6' },
    { name: 'Ready for claiming', value: requests.filter((r) => r.status === 'ready_for_claiming').length, color: '#10b981' },
    { name: 'Denied', value: requests.filter((r) => r.status === 'denied').length, color: '#ef4444' },
  ];

  // Assistance Type Distribution
  const typeData = Object.entries(
    requests.reduce(
      (acc, req) => {
        acc[req.assistanceType] = (acc[req.assistanceType] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
  ).map(([name, value]) => ({ name, value }));

  // CMO processing completion rate
  const totalRequests = requests.length;
  const completedRequests = requests.filter((r) => r.status === 'approved' || r.status === 'ready_for_claiming').length;
  const completionRate = totalRequests > 0 ? Math.round((completedRequests / totalRequests) * 100) : 0;

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2,
      },
    },
  };

  const cardVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, ease: 'easeOut' },
    },
  };

  const kpiStyles = {
    blue: 'bg-white border-slate-200',
    green: 'bg-emerald-50 border-emerald-200',
    purple: 'bg-blue-50 border-blue-200',
    yellow: 'bg-slate-50 border-slate-200',
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading analytics...</div>;
  }

  return (
    <motion.div
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* KPI Cards */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        variants={containerVariants}
      >
        {[
          { label: 'Total Requests', value: totalRequests, color: 'blue' },
          { label: 'Completion Rate', value: `${completionRate}%`, color: 'green' },
          { label: 'Under Review', value: requests.filter((r) => r.status === 'under_review').length, color: 'purple' },
          { label: 'Pending Reviews', value: requests.filter((r) => r.status === 'pending').length, color: 'yellow' },
        ].map((kpi, idx) => (
          <motion.div
            key={kpi.label}
            className={`rounded-lg p-6 border ${kpiStyles[kpi.color as keyof typeof kpiStyles]}`}
            variants={cardVariants}
            whileHover={{ scale: 1.02, y: -5 }}
          >
            <p className={`text-sm font-medium ${kpi.color === 'green' ? 'text-emerald-700' : kpi.color === 'purple' ? 'text-blue-700' : 'text-slate-600'}`}>{kpi.label}</p>
            <motion.p
              className={`text-3xl font-bold mt-2 ${kpi.color === 'green' ? 'text-emerald-900' : kpi.color === 'purple' ? 'text-blue-900' : 'text-slate-900'}`}
              key={kpi.value}
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.3 }}
            >
              {kpi.value}
            </motion.p>
          </motion.div>
        ))}
      </motion.div>

      {/* Charts Grid */}
      <motion.div
        className="grid grid-cols-1 lg:grid-cols-2 gap-6"
        variants={containerVariants}
      >
        {/* Status Distribution Pie Chart */}
        <motion.div
          className="bg-white rounded-lg border border-gray-200 p-6"
          variants={cardVariants}
          whileHover={{ boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)' }}
        >
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Request Status Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={statusData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, value }) => `${name}: ${value}`}
                outerRadius={100}
                fill="#8884d8"
                dataKey="value"
              >
                {statusData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `${value} requests`} />
            </PieChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Assistance Type Bar Chart */}
        <motion.div
          className="bg-white rounded-lg border border-gray-200 p-6"
          variants={cardVariants}
          whileHover={{ boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)' }}
        >
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Requests by Assistance Type</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={typeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e5e7eb' }}
                formatter={(value) => `${value} requests`}
              />
              <Bar dataKey="value" fill="#3b82f6" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>
      </motion.div>

      {/* Status Summary Cards */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-3 gap-6"
        variants={containerVariants}
      >
        {[
          {
            status: 'pending',
            label: 'Pending Review',
            count: requests.filter((r) => r.status === 'pending').length,
            color: 'slate',
            bgColor: 'bg-slate-50',
            textColor: 'text-slate-700',
          },
          {
            status: 'approved',
            label: 'Completed',
            count: requests.filter((r) => r.status === 'approved' || r.status === 'ready_for_claiming').length,
            color: 'green',
            bgColor: 'bg-green-50',
            textColor: 'text-green-700',
          },
          {
            status: 'denied',
            label: 'Denied',
            count: requests.filter((r) => r.status === 'denied').length,
            color: 'red',
            bgColor: 'bg-red-50',
            textColor: 'text-red-700',
          },
        ].map((item) => (
          <motion.div
            key={item.status}
            className={`${item.bgColor} rounded-lg p-6 border ${item.status === 'pending' ? 'border-slate-200' : item.status === 'approved' ? 'border-green-200' : 'border-red-200'}`}
            variants={cardVariants}
            whileHover={{ scale: 1.02 }}
          >
            <p className={`text-sm font-medium ${item.textColor}`}>{item.label}</p>
            <motion.p
              className={`text-4xl font-bold ${item.textColor} mt-2`}
              key={item.count}
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              {item.count}
            </motion.p>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
