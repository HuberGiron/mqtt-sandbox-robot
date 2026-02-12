let errorChart, positionChart, controlChart;

function initCharts(timeData, errorXData, errorYData, posXData, posYData, VData, WData, goalXData, goalYData) {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    // parsing: false,   // <-- QUITAR (esto te rompe series con data numérica)
    // normalized: true, // opcional; puedes dejarlo fuera
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { display: true },
      decimation: { enabled: true, algorithm: 'min-max' }
    },
    scales: {
      x: {
        title: { display: true, text: 'Tiempo (s)' },
        grid: { display: false },
        ticks: { autoSkip: true, maxTicksLimit: 10 }
      },
      y: {
        title: { display: true, text: 'Valor' },
        grid: { display: false }
      }
    }
  };

  errorChart = new Chart(document.getElementById('errorChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'Error X (mm)',
          data: errorXData,
          borderColor: 'red',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Error Y (mm)',
          data: errorYData,
          borderColor: 'blue',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: commonOptions
  });

  positionChart = new Chart(document.getElementById('positionChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'Posición X (mm)',
          data: posXData,
          borderColor: 'green',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Posición Y (mm)',
          data: posYData,
          borderColor: 'orange',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Objetivo Xs (mm)',
          data: goalXData,
          borderColor: 'rgba(0,0,0,0.35)',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0,
          borderDash: [6, 6]
        },
        {
          label: 'Objetivo Ys (mm)',
          data: goalYData,
          borderColor: 'rgba(0,0,0,0.35)',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0,
          borderDash: [2, 6]
        }
      ]
    },
    options: commonOptions
  });

  controlChart = new Chart(document.getElementById('controlChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'V (mm/s)',
          data: VData,
          borderColor: 'purple',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'W (rad/s)',
          data: WData,
          borderColor: 'gray',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 }, // Actualización instantánea
      scales: {
        x: {
          title: { display: true, text: 'Tiempo (s)' },
          grid: { display: false },
          ticks: {
            autoSkip: true,
            maxTicksLimit: 10
          }
        },
        y: {
          title: { display: true, text: 'Valor' },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          display: true
        }
      }
    }
  });
}

function updateCharts(mode = 'none') {
  if (!errorChart || !positionChart || !controlChart) return;

  // 'none' evita animaciones/transition innecesarias en updates frecuentes
  errorChart.update(mode);
  positionChart.update(mode);
  controlChart.update(mode);
}


function downloadChart(chartInstance, fileName) {
  const link = document.createElement('a');
  link.href = chartInstance.toBase64Image();
  link.download = fileName + '.png';
  link.click();
}

function downloadCSVForChart(chartType) {
  let csv = '';
  let fileName = '';
  if (chartType === 'error') {
    fileName = 'error_chart_data';
    csv += 'Tiempo (s),Error X (mm),Error Y (mm)\n';
    for (let i = 0; i < timeData.length; i++) {
      csv += timeData[i] + ',' + errorXData[i] + ',' + errorYData[i] + '\n';
    }
  } else if (chartType === 'position') {
    fileName = 'position_chart_data';
    csv += 'Tiempo (s),Extensión X (mm),Extensión Y (mm),Objetivo Xs (mm),Objetivo Ys (mm),Centro X (mm),Centro Y (mm)\n';
    //csv += 'Tiempo (s),Posición X (mm),Posición Y (mm),Objetivo Xs (mm),Objetivo Ys (mm),Ext X (mm),Ext Y (mm)\n';
    //csv += 'Tiempo (s),Posición X (mm),Posición Y (mm),Ext X (mm),Ext Y (mm)\n';

    for (let i = 0; i < timeData.length; i++) {
      const xs = (typeof goalXData !== 'undefined' && goalXData[i] != null) ? goalXData[i] : '';
      const ys = (typeof goalYData !== 'undefined' && goalYData[i] != null) ? goalYData[i] : '';
      const exx = (typeof extXData !== 'undefined' && extXData[i] != null) ? extXData[i] : '';
      const eyy = (typeof extYData !== 'undefined' && extYData[i] != null) ? extYData[i] : '';
      csv += timeData[i] + ',' + posXData[i] + ',' + posYData[i] + ',' + xs + ',' + ys + ',' + exx + ',' + eyy +'\n';
      //csv += timeData[i] + ',' + posXData[i] + ',' + posYData[i] + ',' + exx + ',' + eyy + '\n';
    }
  } else if (chartType === 'control') {
    fileName = 'control_chart_data';
    csv += 'Tiempo (s),V (mm/s),W (rad/s)\n';
    for (let i = 0; i < timeData.length; i++) {
      csv += timeData[i] + ',' + VData[i] + ',' + WData[i] + '\n';
    }
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", fileName + ".csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
